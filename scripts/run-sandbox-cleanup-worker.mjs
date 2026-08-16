import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { resetEveSession } from "../server/agent-runs/eve-adapter.ts";
import { closeAgentDatabasePools, getAgentDatabasePool, quoteIdentifier, readAgentDatabaseConfig } from "../server/data/agent-database.ts";
import { createPostgresSandboxDeletionStoreFromEnvironment } from "../server/data/sandbox-deletion-store.ts";

const config = readConfig(process.env);
const database = getAgentDatabasePool(config.database);
const deletionStore = createPostgresSandboxDeletionStoreFromEnvironment(process.env);
if (!deletionStore) throw new Error("AGENT_DATABASE_URL is required for the sandbox cleanup worker.");

let stopped = false;
let running = false;
let failureDelayMs = config.intervalMs;
let wake;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopped = true;
  wake?.();
});

try {
  while (!stopped) {
    if (!running) {
      running = true;
      try {
        const result = await cleanupPass({ config, database, deletionStore });
        failureDelayMs = config.intervalMs;
        if (result.considered > 0 || result.removed > 0 || result.failed > 0) {
          console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
        }
      } catch (error) {
        console.error("Sandbox cleanup failed", error instanceof Error ? error.message : String(error));
        failureDelayMs = Math.min(60_000, Math.max(config.intervalMs, failureDelayMs * 2));
      } finally {
        running = false;
      }
    }
    if (stopped) break;
    await interruptibleDelay(failureDelayMs);
  }
} finally {
  await closeAgentDatabasePools();
}

async function cleanupPass({ config, database, deletionStore }) {
  const sessions = await findTerminalSessions(database, config);
  let removed = 0;
  let failed = 0;
  const skipped = [];

  for (const session of sessions) {
    if (stopped) break;
    const existing = await deletionStore.findOwned(session.sessionId, session.owner);
    if (existing?.status === "completed") {
      skipped.push({ sessionId: session.sessionId, reason: "already-completed" });
      continue;
    }
    if (existing?.status === "claimed" && existing.claimExpiresAt && Date.parse(existing.claimExpiresAt) > Date.now()) {
      skipped.push({ sessionId: session.sessionId, reason: "claimed" });
      continue;
    }

    try {
      // A terminal Eve session can still own a persistent Docker container.
      // Retire the durable session before writing the deletion authorization so
      // an active follow-up can never race a container removal.
      if (!existing) {
        const token = createOwnerToken(session.owner, config.environment);
        await resetEveSession(session.sessionId, token, `sandbox-cleanup-${randomUUID()}`);
      }

      const authorization = await deletionStore.request({
        owner: session.owner,
        reason: "terminal-session-retention",
        requestedBy: "worker:sandbox-cleanup",
        sessionId: session.sessionId,
      });
      if (!("record" in authorization)) {
        skipped.push({ sessionId: session.sessionId, reason: authorization.status });
        continue;
      }

      const reaped = runExactReaper(session.sessionId, config.environment);
      if (reaped.removed.length > 0) {
        removed += reaped.removed.length;
      } else if (reaped.unauthorized.length > 0) {
        failed += 1;
      } else {
        skipped.push({ sessionId: session.sessionId, reason: "container-not-found" });
      }
    } catch (error) {
      failed += 1;
      console.error("Sandbox cleanup session failed", {
        message: error instanceof Error ? error.message : String(error),
        sessionId: session.sessionId,
      });
    }
  }

  return { considered: sessions.length, failed, removed, skipped };
}

async function findTerminalSessions(pool, config) {
  const schema = quoteIdentifier(config.database.schema);
  const result = await pool.query(`
    select distinct on (r.eve_session_id)
      r.eve_session_id as "sessionId",
      o.tenant_id as "tenantId",
      o.principal_id as "principalId",
      o.principal_type as "principalType",
      o.issuer,
      r.updated_at as "updatedAt"
    from ${schema}."agent_runs" r
    join ${schema}."agent_session_owners" o on o.session_id = r.eve_session_id
    where r.eve_session_id is not null
      and r.status in ('completed', 'failed', 'cancelled', 'submission-ambiguous')
      and r.updated_at < now() - ($1::bigint * interval '1 millisecond')
      and not exists (
        select 1 from ${schema}."agent_runs" active
        where active.eve_session_id = r.eve_session_id
          and active.status in ('submitting', 'running', 'waiting-input', 'waiting-authorization')
      )
      and not exists (
        select 1 from ${schema}."agent_mailbox_items" mailbox
        where mailbox.session_id = r.eve_session_id
          and mailbox.status in ('queued', 'delivering', 'accepted')
      )
      and not exists (
        select 1 from ${schema}."agent_subagent_sessions" child
        where child.child_session_id = r.eve_session_id
          and child.status in ('starting', 'running', 'waiting')
      )
      and o.issuer = $3
    order by r.eve_session_id, r.updated_at desc
    limit $2
  `, [config.retentionHours * 60 * 60 * 1_000, config.maxSessions, config.hostIssuer]);

  return result.rows.map((row) => ({
    owner: {
      issuer: row.issuer ?? undefined,
      principalId: String(row.principalId),
      principalType: String(row.principalType),
      tenantId: String(row.tenantId),
    },
    sessionId: String(row.sessionId),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }));
}

function runExactReaper(sessionId, environment) {
  const output = execFileSync(
    process.execPath,
    [
      "scripts/reap-docker-sandboxes.mjs",
      "--apply",
      "--include-running",
      "--session-id", sessionId,
      "--retention-hours", "0",
      "--max-removals", "1",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: environment },
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Sandbox reaper returned invalid JSON.");
  }
}

function createOwnerToken(owner, environment) {
  const secret = required(environment.AGENT_HOST_JWT_SECRET, "AGENT_HOST_JWT_SECRET");
  const issuer = required(environment.AGENT_HOST_JWT_ISSUER, "AGENT_HOST_JWT_ISSUER");
  const audience = required(environment.AGENT_HOST_JWT_AUDIENCE, "AGENT_HOST_JWT_AUDIENCE");
  if (owner.issuer && owner.issuer !== issuer) {
    throw new Error("The stored session issuer does not match the configured Host issuer.");
  }
  const prefix = `${issuer}:`;
  const subject = owner.principalId.startsWith(prefix)
    ? owner.principalId.slice(prefix.length)
    : owner.principalId;
  if (!subject || subject.length > 512 || /[\u0000-\u001f\u007f]/u.test(subject)) {
    throw new Error("The stored session principal cannot be represented as a Host subject.");
  }
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    actorType: owner.principalType === "service" ? "service" : "user",
    aud: audience,
    exp: now + 300,
    iat: now,
    iss: issuer,
    jti: randomUUID(),
    scope: ["agent:runs"],
    sub: subject,
    tenantId: owner.tenantId,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function readConfig(environment) {
  const database = readAgentDatabaseConfig(environment);
  if (!database) throw new Error("AGENT_DATABASE_URL is required for the sandbox cleanup worker.");
  const backend = environment.AGENT_SANDBOX_BACKEND?.trim() || "auto";
  if (backend !== "docker") {
    throw new Error("The sandbox cleanup worker only supports AGENT_SANDBOX_BACKEND=docker.");
  }
  return {
    database,
    environment,
    intervalMs: boundedInteger(environment.AGENT_SANDBOX_CLEANUP_INTERVAL_MS, 900_000, 1_000, 86_400_000),
    maxSessions: boundedInteger(environment.AGENT_SANDBOX_CLEANUP_MAX_SESSIONS, 25, 1, 10_000),
    retentionHours: boundedInteger(environment.AGENT_SANDBOX_TERMINAL_RETENTION_HOURS, 168, 1, 87_600),
    hostIssuer: required(environment.AGENT_HOST_JWT_ISSUER, "AGENT_HOST_JWT_ISSUER"),
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Sandbox cleanup configuration must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for sandbox cleanup.`);
  return normalized;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
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
