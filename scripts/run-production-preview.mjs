import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import {
  assertBuiltEveProxy,
  assertBuiltEveWorkflowWorld,
  configureEveNextProductionPort,
  PRODUCTION_PREVIEW_PORTS,
} from "./production-preview-topology.mjs";
import {
  resolveProductionPreviewHostJwtSecret,
  resolveProductionPreviewSigningSecret,
} from "./production-preview-secret.mjs";

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
const hostJwtSecret = await resolveProductionPreviewHostJwtSecret();
const minioEnvironment = containerEnvironment("open-agent-gate-minio");
const mailboxDispatchSecret = process.env.AGENT_MAILBOX_DISPATCH_SECRET?.trim() || randomBytes(32).toString("base64url");
const mailboxWorkerSecret = process.env.AGENT_MAILBOX_WORKER_SECRET?.trim() || randomBytes(32).toString("base64url");
const runtimeEnvironment = {
  ...process.env,
  AGENT_BASH_APPROVAL_MODE: "risky",
  AGENT_DATABASE_SCHEMA: "open_agent",
  AGENT_ASSET_CLEANUP_INTERVAL_MS: "3600000",
  AGENT_ASSET_CLEANUP_LIMIT: "100",
  AGENT_ASSET_CLAMAV_HOST: "127.0.0.1",
  AGENT_ASSET_CLAMAV_PORT: "53310",
  AGENT_ASSET_CLAMAV_TIMEOUT_MS: "600000",
  AGENT_ASSET_MAX_BYTES: "1GiB",
  AGENT_ASSET_QUOTA_BYTES: "2GiB",
  AGENT_ASSET_S3_ACCESS_KEY_ID: requiredContainerValue(minioEnvironment, "MINIO_ROOT_USER", "open-agent-gate-minio"),
  AGENT_ASSET_S3_BUCKET: "open-agent-assets",
  AGENT_ASSET_S3_ENDPOINT: "http://127.0.0.1:59000",
  AGENT_ASSET_S3_FORCE_PATH_STYLE: "true",
  AGENT_ASSET_S3_REGION: "us-east-1",
  AGENT_ASSET_S3_SECRET_ACCESS_KEY: requiredContainerValue(minioEnvironment, "MINIO_ROOT_PASSWORD", "open-agent-gate-minio"),
  AGENT_ASSET_SCAN_MODE: "required",
  AGENT_ASSET_STORAGE_BACKEND: "s3",
  AGENT_DATABASE_URL: postgresUrl("open-agent-gate-data", 56432),
  AGENT_DEPLOYMENT_TENANCY: "single-tenant",
  AGENT_DOCKER_MEMORY_LIMIT_BYTES: process.env.AGENT_DOCKER_MEMORY_LIMIT_BYTES || "2GiB",
  AGENT_DOCKER_CPU_LIMIT: process.env.AGENT_DOCKER_CPU_LIMIT || "2",
  AGENT_DOCKER_PIDS_LIMIT: process.env.AGENT_DOCKER_PIDS_LIMIT || "512",
  AGENT_EMBED_ALLOWED_ORIGINS: process.env.AGENT_EMBED_ALLOWED_ORIGINS || "http://localhost:4730,http://127.0.0.1:4730",
  AGENT_HOST_JWT_AUDIENCE: process.env.AGENT_HOST_JWT_AUDIENCE || "open-agent-local-production",
  AGENT_HOST_JWT_ISSUER: process.env.AGENT_HOST_JWT_ISSUER || "https://open-agent.local",
  AGENT_HOST_JWT_SECRET: hostJwtSecret,
  AGENT_MODEL_MAX_OUTPUT_TOKENS: "4096",
  // Admission is persisted in PostgreSQL so multiple Web replicas cannot
  // oversubscribe this small single-host preview. Hosts with a scheduler may
  // override both values with their measured safe limits.
  AGENT_MAX_ACTIVE_RUNS_TOTAL: process.env.AGENT_MAX_ACTIVE_RUNS_TOTAL || "16",
  AGENT_MAX_ACTIVE_RUNS_PER_TENANT: process.env.AGENT_MAX_ACTIVE_RUNS_PER_TENANT || "16",
  AGENT_RUN_RECONCILE_INTERVAL_MS: process.env.AGENT_RUN_RECONCILE_INTERVAL_MS || "60000",
  AGENT_RUN_RECONCILE_LIMIT: process.env.AGENT_RUN_RECONCILE_LIMIT || "100",
  AGENT_RUN_SUBMISSION_STALE_MS: process.env.AGENT_RUN_SUBMISSION_STALE_MS || "120000",
  AGENT_MAILBOX_DISPATCH_SECRET: mailboxDispatchSecret,
  AGENT_MAILBOX_WORKER_SECRET: mailboxWorkerSecret,
  AGENT_MAILBOX_WORKER_INTERVAL_MS: process.env.AGENT_MAILBOX_WORKER_INTERVAL_MS || "1000",
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
  EVE_SANDBOX_RETENTION_HOURS: process.env.EVE_SANDBOX_RETENTION_HOURS || "168",
  EVE_SANDBOX_REAPER_MAX_REMOVALS: process.env.EVE_SANDBOX_REAPER_MAX_REMOVALS || "50",
  EVE_NEXT_PRODUCTION_PORT: String(EVE_PORT),
  NODE_ENV: previewNodeEnv,
  OTEL_EXPORTER_OTLP_PROTOCOL: process.env.OTEL_EXPORTER_OTLP_PROTOCOL || "http/json",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://127.0.0.1:4318/v1/traces",
  WORKFLOW_POSTGRES_JOB_PREFIX: "open_agent_",
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: "22",
  WORKFLOW_POSTGRES_URL: postgresUrl("open-agent-gate-world", 56433),
  WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "20",
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
};

await assertPortsAvailable([WEB_PORT, EVE_PORT, 4318]);

const migration = spawnSync(process.execPath, ["scripts/migrate-agent-data.mjs"], {
  env: runtimeEnvironment,
  stdio: "inherit",
});
if (migration.status !== 0) process.exit(migration.status ?? 1);

const collector = spawn(process.execPath, ["scripts/mock-otlp-json.mjs"], {
  env: { ...runtimeEnvironment, MOCK_OTLP_PORT: "4318" },
  stdio: "inherit",
});
await waitForHealth("http://127.0.0.1:4318/debug/traces", collector);

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

const runReconciler = spawn(process.execPath, ["scripts/run-agent-run-reconciler.mjs"], {
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
  runReconciler.kill(signal);
  collector.kill(signal);
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
  childExit("run-reconciler", runReconciler),
  childExit("otel-collector", collector),
]);
stop();
await Promise.allSettled([
  childExit("eve", eve),
  childExit("web", web),
  childExit("mailbox-worker", mailboxWorker),
  childExit("asset-cleanup-worker", assetCleanupWorker),
  childExit("sandbox-cleanup-worker", sandboxCleanupWorker),
  childExit("run-reconciler", runReconciler),
  childExit("otel-collector", collector),
]);
if (!stopping || outcome.code !== 0) {
  console.error(`${outcome.name} exited`, { code: outcome.code, signal: outcome.signal });
}
process.exitCode = shutdownRequested ? 0 : outcome.code ?? (outcome.signal ? 1 : 0);

function containerEnvironment(container) {
  const raw = execFileSync("docker", ["inspect", "--format", "{{json .Config.Env}}", container], { encoding: "utf8" });
  return Object.fromEntries(JSON.parse(raw).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function postgresUrl(container, port) {
  const values = containerEnvironment(container);
  const url = new URL(
    `postgresql://127.0.0.1:${port}/${values.POSTGRES_DB || "postgres"}`,
  );
  url.username = values.POSTGRES_USER || "postgres";
  url.password = values.POSTGRES_PASSWORD || "";
  return url.toString();
}

function requiredContainerValue(environment, name, container) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${container} does not provide ${name}.`);
  return value;
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

async function assertPortsAvailable(ports) {
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", () => reject(new Error(`Local production port ${port} is already in use.`)));
      server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
    });
  }
}

function childExit(name, child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, name, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, name, signal }));
  });
}
