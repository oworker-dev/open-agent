import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import {
  assertBuiltEveProxy,
  assertBuiltEveWorkflowWorld,
  configureEveNextProductionPort,
  PRODUCTION_PREVIEW_PORTS,
} from "./production-preview-topology.mjs";
import { resolveProductionPreviewSigningSecret } from "./production-preview-secret.mjs";

const WEB_PORT = PRODUCTION_PREVIEW_PORTS.web;
const EVE_PORT = configureEveNextProductionPort();
const SANDBOX_IMAGE = "ghcr.io/oworker-dev/open-agent-sandbox@sha256:44e675839b0e4e16a97e5aceb86ef001fd379ae2642efe4d3bbead9d333f14d9";
const previewNodeEnv = process.env.OPEN_AGENT_PREVIEW_NODE_ENV?.trim() || "production";
if (previewNodeEnv !== "production" && previewNodeEnv !== "development") {
  throw new Error("OPEN_AGENT_PREVIEW_NODE_ENV must be production or development.");
}

await Promise.all([
  access(new URL("../.next/BUILD_ID", import.meta.url)),
  access(new URL("../.output/server/index.mjs", import.meta.url)),
]);
const routesManifest = JSON.parse(
  await readFile(new URL("../.next/routes-manifest.json", import.meta.url), "utf8"),
);
assertBuiltEveProxy(routesManifest, EVE_PORT);
const compiledAgentManifest = JSON.parse(
  await readFile(new URL("../.output/.eve/compile/compiled-agent-manifest.json", import.meta.url), "utf8"),
);
assertBuiltEveWorkflowWorld(compiledAgentManifest);

const publicOrigin = await resolvePublicOrigin();
const previewSigningSecret = await resolveProductionPreviewSigningSecret();
const mailboxDispatchSecret = process.env.AGENT_MAILBOX_DISPATCH_SECRET?.trim() || randomBytes(32).toString("base64url");
const mailboxWorkerSecret = process.env.AGENT_MAILBOX_WORKER_SECRET?.trim() || randomBytes(32).toString("base64url");
const runtimeEnvironment = {
  ...process.env,
  AGENT_BASH_APPROVAL_MODE: "risky",
  AGENT_DATABASE_SCHEMA: "open_agent",
  AGENT_ASSET_CLEANUP_INTERVAL_MS: "3600000",
  AGENT_ASSET_CLEANUP_LIMIT: "100",
  AGENT_DATABASE_URL: postgresUrl("open-agent-prod-data", 55432),
  AGENT_DEPLOYMENT_TENANCY: "single-tenant",
  AGENT_EMBED_ALLOWED_ORIGINS: process.env.AGENT_EMBED_ALLOWED_ORIGINS || "http://localhost:4730,http://127.0.0.1:4730",
  AGENT_MODEL_MAX_OUTPUT_TOKENS: "4096",
  AGENT_MAILBOX_DISPATCH_SECRET: mailboxDispatchSecret,
  AGENT_MAILBOX_WORKER_SECRET: mailboxWorkerSecret,
  AGENT_PREVIEW_SIGNING_SECRET: previewSigningSecret,
  AGENT_PROVIDER_HTTP_TIMEOUT_MS: "600000",
  AGENT_PROVIDER_MODE: "live",
  AGENT_PUBLIC_BASE_URL: publicOrigin,
  AGENT_RUNTIME_URL: `http://127.0.0.1:${EVE_PORT}`,
  AGENT_SANDBOX_BACKEND: "docker",
  AGENT_SANDBOX_IMAGE: SANDBOX_IMAGE,
  AGENT_SANDBOX_TERMINAL_RETENTION_HOURS: process.env.AGENT_SANDBOX_TERMINAL_RETENTION_HOURS || "168",
  AGENT_SANDBOX_CLEANUP_INTERVAL_MS: process.env.AGENT_SANDBOX_CLEANUP_INTERVAL_MS || "900000",
  AGENT_SANDBOX_CLEANUP_MAX_SESSIONS: process.env.AGENT_SANDBOX_CLEANUP_MAX_SESSIONS || "25",
  EVE_NEXT_PRODUCTION_PORT: String(EVE_PORT),
  NODE_ENV: previewNodeEnv,
  WORKFLOW_POSTGRES_JOB_PREFIX: "open_agent_",
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: "22",
  WORKFLOW_POSTGRES_URL: postgresUrl("open-agent-prod-world", 55433),
  WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "20",
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
};

const migration = spawnSync(process.execPath, ["scripts/migrate-agent-data.mjs"], {
  env: runtimeEnvironment,
  stdio: "inherit",
});
if (migration.status !== 0) process.exit(migration.status ?? 1);

const eve = spawn(process.execPath, [".output/server/index.mjs"], {
  env: {
    ...runtimeEnvironment,
    HOST: "127.0.0.1",
    PORT: String(EVE_PORT),
  },
  stdio: "inherit",
});

await waitForHealth(`http://127.0.0.1:${EVE_PORT}/eve/v1/health`, eve);

const web = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", String(WEB_PORT)],
  { env: runtimeEnvironment, stdio: "inherit" },
);

await waitForHealth(`http://127.0.0.1:${WEB_PORT}`, web);

const mailboxWorker = spawn(process.execPath, ["scripts/run-agent-mailbox-worker.mjs"], {
  env: {
    ...runtimeEnvironment,
    AGENT_WEB_INTERNAL_URL: `http://127.0.0.1:${WEB_PORT}`,
  },
  stdio: "inherit",
});

const assetCleanupWorker = spawn(process.execPath, ["scripts/run-asset-cleanup-worker.mjs"], {
  env: runtimeEnvironment,
  stdio: "inherit",
});

const sandboxCleanupWorker = spawn(process.execPath, ["scripts/run-sandbox-cleanup-worker.mjs"], {
  env: runtimeEnvironment,
  stdio: "inherit",
});

console.log(`OPEN_AGENT_PUBLIC_URL=${publicOrigin}`);

let stopping = false;
let shutdownRequested = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  web.kill(signal);
  eve.kill(signal);
  mailboxWorker.kill(signal);
  assetCleanupWorker.kill(signal);
  sandboxCleanupWorker.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdownRequested = true;
    stop(signal);
  });
}

const outcome = await Promise.race([
  childExit("eve", eve),
  childExit("web", web),
  childExit("mailbox-worker", mailboxWorker),
  childExit("asset-cleanup-worker", assetCleanupWorker),
  childExit("sandbox-cleanup-worker", sandboxCleanupWorker),
]);
stop();
await Promise.allSettled([
  childExit("eve", eve),
  childExit("web", web),
  childExit("mailbox-worker", mailboxWorker),
  childExit("asset-cleanup-worker", assetCleanupWorker),
  childExit("sandbox-cleanup-worker", sandboxCleanupWorker),
]);
if (!stopping || outcome.code !== 0) {
  console.error(`${outcome.name} exited`, { code: outcome.code, signal: outcome.signal });
}
process.exitCode = shutdownRequested ? 0 : outcome.code ?? (outcome.signal ? 1 : 0);

function postgresUrl(container, port) {
  const raw = execFileSync(
    "docker",
    ["inspect", "--format", "{{json .Config.Env}}", container],
    { encoding: "utf8" },
  );
  const values = Object.fromEntries(JSON.parse(raw).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const url = new URL(
    `postgresql://127.0.0.1:${port}/${values.POSTGRES_DB || "postgres"}`,
  );
  url.username = values.POSTGRES_USER || "postgres";
  url.password = values.POSTGRES_PASSWORD || "";
  return url.toString();
}

async function resolvePublicOrigin() {
  try {
    const response = await fetch("https://api.ipify.org", {
      signal: AbortSignal.timeout(5_000),
    });
    const address = response.ok ? (await response.text()).trim() : "";
    if (/^[0-9a-f:.]+$/iu.test(address)) {
      return `http://${address.includes(":") ? `[${address}]` : address}:${WEB_PORT}`;
    }
  } catch {
    // Use the loopback preview origin when public discovery is unavailable.
  }
  return `http://127.0.0.1:${WEB_PORT}`;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Eve exited before becoming healthy.");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Continue until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Eve did not become healthy within 30 seconds.");
}

function childExit(name, child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, name, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, name, signal }));
  });
}
