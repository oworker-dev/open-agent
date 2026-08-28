import { createHmac, randomUUID } from "node:crypto";
import { closeAgentDatabasePools, readAgentDatabaseConfig } from "../server/data/agent-database.ts";
import { createPostgresAgentRunStoreFromEnvironment } from "../server/data/agent-run-store.ts";
import { reconcileStaleSubmissions } from "../server/agent-runs/reconcile.ts";
import { eveAgentRunRuntime } from "../server/agent-runs/service.ts";

const database = readAgentDatabaseConfig(process.env);
if (!database) throw new Error("AGENT_DATABASE_URL is required for the AgentRun reconciler.");
const store = createPostgresAgentRunStoreFromEnvironment(process.env);
if (!store) throw new Error("AGENT_DATABASE_URL is required for the AgentRun reconciler.");

const intervalMs = boundedInteger("AGENT_RUN_RECONCILE_INTERVAL_MS", 60_000, 1_000, 86_400_000);
const staleMs = boundedInteger("AGENT_RUN_SUBMISSION_STALE_MS", 120_000, 10_000, 86_400_000);
const limit = boundedInteger("AGENT_RUN_RECONCILE_LIMIT", 100, 1, 10_000);
const runtimeConfigured = Boolean(
  process.env.AGENT_RUNTIME_URL?.trim()
  && process.env.AGENT_HOST_JWT_SECRET?.trim()
  && process.env.AGENT_HOST_JWT_ISSUER?.trim()
  && process.env.AGENT_HOST_JWT_AUDIENCE?.trim(),
);
let stopped = false;
let wake;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    wake?.();
  });
}

try {
  while (!stopped) {
    try {
      const result = await reconcileStaleSubmissions({
        accessTokenFor: runtimeConfigured ? (record) => signReconcilerToken(record) : undefined,
        limit,
        olderThanMs: staleMs,
        runtime: runtimeConfigured ? eveAgentRunRuntime : undefined,
        store,
      });
      if (result.inspected > 0 || result.failures > 0) {
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      }
    } catch (error) {
      console.error("AgentRun reconciliation failed", error instanceof Error ? error.message : String(error));
    }
    await interruptibleDelay(intervalMs);
  }
} finally {
  await closeAgentDatabasePools();
}

function signReconcilerToken(record) {
  const secret = process.env.AGENT_HOST_JWT_SECRET?.trim();
  const issuer = process.env.AGENT_HOST_JWT_ISSUER?.trim();
  const audience = process.env.AGENT_HOST_JWT_AUDIENCE?.trim();
  if (!secret || !issuer || !audience) throw new Error("Host JWT configuration is required for session cleanup.");
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    // Session ownership includes the authenticated principal type. Preserve
    // it when minting the short-lived cleanup token so the reconciler cannot
    // cross an owner boundary while addressing the exact session.
    actorType: record.principalType,
    aud: audience,
    exp: now + 300,
    iat: now,
    iss: issuer,
    jti: randomUUID(),
    scope: ["agent:sessions"],
    sub: record.principalId,
    tenantId: record.tenantId,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = process.env[name]?.trim() ? Number(process.env[name]) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function interruptibleDelay(milliseconds) {
  if (stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = undefined;
      resolve();
    }, milliseconds);
    wake = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
  });
}
