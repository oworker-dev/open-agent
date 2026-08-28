import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import {
  assertBuiltEveProxy,
  assertBuiltEveWorkflowWorld,
  configureEveNextProductionPort,
  PRODUCTION_PREVIEW_DEFAULT_ACTIVE_RUNS,
  productionPreviewExitCode,
  PRODUCTION_PREVIEW_PORTS,
} from "./production-preview-topology.mjs";
import {
  resolveProductionPreviewHostJwtSecret,
  resolveProductionPreviewSigningSecret,
} from "./production-preview-secret.mjs";
import {
  readPreviewProxyMaxSockets,
  startProductionPreviewGateway,
} from "./production-preview-gateway.mjs";

const WEB_PORT = PRODUCTION_PREVIEW_PORTS.web;
const NEXT_PORT = PRODUCTION_PREVIEW_PORTS.next;
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
// Keep diagnostics protected while making the local production preview
// observable by the capacity verifiers. The generated value is shared by all
// preview workers through this process environment and never sent to clients.
const metricsSecret = process.env.AGENT_METRICS_SECRET?.trim() || randomBytes(32).toString("base64url");
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
  AGENT_SANDBOX_IDLE_TIMEOUT_MS: process.env.AGENT_SANDBOX_IDLE_TIMEOUT_MS
    || process.env.AGENT_DOCKER_IDLE_TIMEOUT_MS
    || "1800000",
  AGENT_DOCKER_PIDS_LIMIT: process.env.AGENT_DOCKER_PIDS_LIMIT || "512",
  AGENT_EMBED_ALLOWED_ORIGINS: process.env.AGENT_EMBED_ALLOWED_ORIGINS || "http://localhost:4730,http://127.0.0.1:4730",
  AGENT_HOST_JWT_AUDIENCE: process.env.AGENT_HOST_JWT_AUDIENCE || "open-agent-local-production",
  AGENT_HOST_JWT_ISSUER: process.env.AGENT_HOST_JWT_ISSUER || "https://open-agent.local",
  AGENT_HOST_JWT_SECRET: hostJwtSecret,
  AGENT_HOST_REQUIRE_DOCKER_LIMITS: process.env.AGENT_HOST_REQUIRE_DOCKER_LIMITS || "1",
  AGENT_METRICS_SECRET: metricsSecret,
  AGENT_MODEL_MAX_OUTPUT_TOKENS: "4096",
  // Admission is persisted in PostgreSQL so multiple Web replicas cannot
  // oversubscribe this small single-host preview. Hosts with a scheduler may
  // override both values with their measured safe limits.
  AGENT_MAX_ACTIVE_RUNS_TOTAL: process.env.AGENT_MAX_ACTIVE_RUNS_TOTAL
    || String(PRODUCTION_PREVIEW_DEFAULT_ACTIVE_RUNS),
  AGENT_MAX_ACTIVE_RUNS_PER_TENANT: process.env.AGENT_MAX_ACTIVE_RUNS_PER_TENANT
    || String(PRODUCTION_PREVIEW_DEFAULT_ACTIVE_RUNS),
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
  AGENT_SANDBOX_MAX_ACTIVE: process.env.AGENT_SANDBOX_MAX_ACTIVE || "2",
  AGENT_SANDBOX_MAX_QUEUED: process.env.AGENT_SANDBOX_MAX_QUEUED || "1024",
  AGENT_SANDBOX_ADMISSION_TIMEOUT_MS: process.env.AGENT_SANDBOX_ADMISSION_TIMEOUT_MS || "30000",
  AGENT_SANDBOX_IMAGE: SANDBOX_IMAGE,
  AGENT_SANDBOX_CLEANUP_INTERVAL_MS: process.env.AGENT_SANDBOX_CLEANUP_INTERVAL_MS || "900000",
  AGENT_SANDBOX_CLEANUP_MAX_SESSIONS: process.env.AGENT_SANDBOX_CLEANUP_MAX_SESSIONS || "25",
  EVE_SANDBOX_RETENTION_HOURS: process.env.EVE_SANDBOX_RETENTION_HOURS || "168",
  EVE_SANDBOX_REAPER_MAX_REMOVALS: process.env.EVE_SANDBOX_REAPER_MAX_REMOVALS || "50",
  EVE_NEXT_PRODUCTION_PORT: String(EVE_PORT),
  NODE_ENV: previewNodeEnv,
  OPEN_AGENT_PREVIEW_PROXY_MAX_SOCKETS: String(readPreviewProxyMaxSockets()),
  OTEL_EXPORTER_OTLP_PROTOCOL: process.env.OTEL_EXPORTER_OTLP_PROTOCOL || "http/json",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://127.0.0.1:4318/v1/traces",
  WORKFLOW_POSTGRES_JOB_PREFIX: "open_agent_",
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: "22",
  WORKFLOW_POSTGRES_URL: postgresUrl("open-agent-gate-world", 56433),
  WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "20",
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
};

let shutdownRequested = false;
let stopping = false;
let gateway;
let stopPromise;
const managedChildren = new Map();
const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => {
    shutdownRequested = true;
    void stop(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

let outcome;
try {
  await assertPortsAvailable([WEB_PORT, NEXT_PORT, EVE_PORT, 4318]);

  const migration = spawnSync(process.execPath, ["scripts/migrate-agent-data.mjs"], {
    env: runtimeEnvironment,
    stdio: "inherit",
  });
  if (migration.error) throw migration.error;
  if (migration.status !== 0) {
    throw new Error(`Agent data migration exited with code ${String(migration.status ?? 1)}.`);
  }

  const collector = spawnManaged("otel-collector", process.execPath, ["scripts/mock-otlp-json.mjs"], {
    env: { ...runtimeEnvironment, MOCK_OTLP_PORT: "4318" },
    stdio: "inherit",
  });
  await waitForHealth("http://127.0.0.1:4318/debug/traces", collector);

  const eve = spawnManaged("eve", process.execPath, [".output/server/index.mjs"], {
    env: {
      ...runtimeEnvironment,
      HOST: "127.0.0.1",
      PORT: String(EVE_PORT),
    },
    stdio: "inherit",
  });
  await waitForHealth(`http://127.0.0.1:${EVE_PORT}/eve/v1/health`, eve);

  const web = spawnManaged(
    "web",
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(NEXT_PORT)],
    { env: runtimeEnvironment, stdio: "inherit" },
  );
  await waitForHealth(`http://127.0.0.1:${NEXT_PORT}`, web);

  assertCanStart();
  const startedGateway = await startProductionPreviewGateway({
    eveOrigin: `http://127.0.0.1:${EVE_PORT}`,
    host: "0.0.0.0",
    maxSockets: readPreviewProxyMaxSockets(runtimeEnvironment),
    port: WEB_PORT,
    webOrigin: `http://127.0.0.1:${NEXT_PORT}`,
  });
  if (stopping) {
    await startedGateway.close();
    throw new Error("Production preview shutdown is already in progress.");
  }
  gateway = startedGateway;
  await waitForHealth(`http://127.0.0.1:${WEB_PORT}`, web, "production-gateway");

  spawnManaged("mailbox-worker", process.execPath, ["scripts/run-agent-mailbox-worker.mjs"], {
    env: {
      ...runtimeEnvironment,
      AGENT_WEB_INTERNAL_URL: `http://127.0.0.1:${NEXT_PORT}`,
    },
    stdio: "inherit",
  });
  spawnManaged("asset-cleanup-worker", process.execPath, ["scripts/run-asset-cleanup-worker.mjs"], {
    env: runtimeEnvironment,
    stdio: "inherit",
  });
  spawnManaged("sandbox-cleanup-worker", process.execPath, ["scripts/run-sandbox-cleanup-worker.mjs"], {
    env: runtimeEnvironment,
    stdio: "inherit",
  });
  spawnManaged("run-reconciler", process.execPath, ["scripts/run-agent-run-reconciler.mjs"], {
    env: runtimeEnvironment,
    stdio: "inherit",
  });

  console.log(`OPEN_AGENT_PUBLIC_URL=${publicOrigin}`);
  outcome = await Promise.race([...managedChildren.values()].map((entry) => entry.exit));
  if (!shutdownRequested) {
    console.error(`${outcome.name} exited unexpectedly`, {
      code: outcome.code,
      error: outcome.error?.message,
      signal: outcome.signal,
    });
  }
} catch (error) {
  if (!shutdownRequested) console.error("Production preview failed", error);
} finally {
  await stop();
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  process.exitCode = outcome
    ? productionPreviewExitCode(outcome, shutdownRequested)
    : shutdownRequested ? 0 : 1;
}

function assertCanStart() {
  if (stopping) throw new Error("Production preview shutdown is already in progress.");
}

function spawnManaged(name, command, args, options) {
  assertCanStart();
  const child = spawn(command, args, options);
  const entry = { child, exit: childExit(name, child), name };
  managedChildren.set(name, entry);
  return entry;
}

function stop(signal = "SIGTERM") {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    const exits = [...managedChildren.values()].map((entry) => entry.exit);
    for (const { child } of managedChildren.values()) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
    const gatewayClose = gateway?.close() ?? Promise.resolve();
    await Promise.race([
      Promise.allSettled(exits),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000)),
    ]);
    for (const { child } of managedChildren.values()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled([gatewayClose, ...exits]);
  })();
  return stopPromise;
}

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

async function waitForHealth(url, entry, serviceName = entry.name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (stopping) throw new Error("Production preview shutdown is already in progress.");
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
      throw new Error(`${serviceName} exited before becoming healthy.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Continue until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${serviceName} did not become healthy within 30 seconds.`);
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
    return Promise.resolve({ code: child.exitCode, error: undefined, name, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => settle({ code: 1, error, name, signal: null }));
    child.once("exit", (code, signal) => settle({ code, error: undefined, name, signal }));
  });
}
