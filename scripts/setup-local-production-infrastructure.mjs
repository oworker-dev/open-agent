import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const LABEL = "open-agent.topology=local-production-v1";
const POSTGRES_IMAGE = "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const CLAMAV_IMAGE = "open-agent-clamav:1.4.3-local";
const BUCKET = "open-agent-assets";
const containers = {
  agentDatabase: "open-agent-gate-data",
  clamav: "open-agent-gate-clamav",
  minio: "open-agent-gate-minio",
  workflowDatabase: "open-agent-gate-world",
};

const command = process.argv[2] ?? "up";
if (!new Set(["up", "status", "stop"]).has(command)) {
  throw new Error("Usage: node scripts/setup-local-production-infrastructure.mjs [up|status|stop]");
}

if (command === "stop") {
  for (const name of Object.values(containers)) stopManagedContainer(name);
  console.log(JSON.stringify({ action: "stopped", containers: Object.values(containers) }));
  process.exit(0);
}

if (command === "up") {
  assertDockerAvailable();
  ensureClamAvImage();
  ensurePostgres(containers.agentDatabase, 56432, "open_agent", "open_agent_data");
  ensurePostgres(containers.workflowDatabase, 56433, "open_agent_workflow", "open_agent_world");
  ensureMinio();
  ensureClamAv();
  for (const name of Object.values(containers)) startContainer(name);
  await Promise.all([
    waitForPostgres(containers.agentDatabase),
    waitForPostgres(containers.workflowDatabase),
    waitForHttp("http://127.0.0.1:59000/minio/health/ready", "MinIO"),
    waitForClamAv(),
  ]);
  await configureBucket();
  bootstrapDatabases();
}

const status = Object.fromEntries(Object.entries(containers).map(([key, name]) => [key, inspectManagedContainer(name)]));
console.log(JSON.stringify({
  action: command,
  bucket: BUCKET,
  endpoints: {
    agentDatabase: "postgresql://127.0.0.1:56432/open_agent_data",
    clamav: "tcp://127.0.0.1:53310",
    minio: "http://127.0.0.1:59000",
    minioConsole: "http://127.0.0.1:59001",
    workflowDatabase: "postgresql://127.0.0.1:56433/open_agent_world",
  },
  status,
}));

function ensurePostgres(name, port, user, database) {
  ensureContainer(name, POSTGRES_IMAGE, [
    "--restart", "unless-stopped",
    "--publish", `127.0.0.1:${port}:5432`,
    "--volume", `${name}-pgdata:/var/lib/postgresql/data`,
    "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_DB=${database}`,
    "--env", `POSTGRES_PASSWORD=${secret()}`,
    "--health-cmd", `pg_isready -U ${user} -d ${database}`,
    "--health-interval", "2s",
    "--health-timeout", "2s",
    "--health-retries", "30",
  ]);
}

function ensureMinio() {
  ensureContainer(containers.minio, MINIO_IMAGE, [
    "--restart", "unless-stopped",
    "--publish", "127.0.0.1:59000:9000",
    "--publish", "127.0.0.1:59001:9001",
    "--volume", `${containers.minio}-data:/data`,
    "--env", `MINIO_ROOT_USER=open_agent_${randomBytes(12).toString("hex")}`,
    "--env", `MINIO_ROOT_PASSWORD=${secret()}`,
    // This MinIO release implements CORS as a server policy rather than the
    // S3 PutBucketCors API. The service is loopback-only and presigned uploads
    // carry no browser credentials; startup probes the real response below.
    "--env", "MINIO_API_CORS_ALLOW_ORIGIN=*",
    "--health-cmd", "curl -fsS http://127.0.0.1:9000/minio/health/ready",
    "--health-interval", "2s",
    "--health-timeout", "2s",
    "--health-retries", "60",
  ], ["server", "/data", "--console-address", ":9001"]);
}

function ensureClamAv() {
  ensureContainer(containers.clamav, CLAMAV_IMAGE, [
    "--restart", "unless-stopped",
    "--publish", "127.0.0.1:53310:3310",
    "--volume", `${containers.clamav}-database:/var/lib/clamav`,
    "--env", "CLAMD_STARTUP_TIMEOUT=1800",
  ]);
}

function ensureContainer(name, image, createOptions, command = []) {
  const existing = inspectContainer(name);
  if (existing) {
    if (existing.Config?.Labels?.["open-agent.topology"] !== "local-production-v1") {
      throw new Error(`Refusing to use unmanaged Docker container ${name}.`);
    }
    return;
  }
  execFileSync("docker", [
    "create",
    "--name", name,
    "--label", LABEL,
    ...createOptions,
    image,
    ...command,
  ], { stdio: "ignore" });
}

function ensureClamAvImage() {
  if (spawnSync("docker", ["image", "inspect", CLAMAV_IMAGE], { stdio: "ignore" }).status === 0) return;
  execFileSync("docker", ["build", "--pull=false", "--tag", CLAMAV_IMAGE, "infrastructure/clamav"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

function startContainer(name) {
  const container = inspectManagedContainer(name);
  if (!container.running) execFileSync("docker", ["start", name], { stdio: "ignore" });
}

function stopManagedContainer(name) {
  const container = inspectContainer(name);
  if (!container) return;
  if (container.Config?.Labels?.["open-agent.topology"] !== "local-production-v1") {
    throw new Error(`Refusing to stop unmanaged Docker container ${name}.`);
  }
  if (container.State?.Running) execFileSync("docker", ["stop", name], { stdio: "ignore" });
}

function inspectManagedContainer(name) {
  const container = inspectContainer(name);
  if (!container) return { exists: false, running: false };
  if (container.Config?.Labels?.["open-agent.topology"] !== "local-production-v1") {
    throw new Error(`Docker container ${name} is not owned by the local Open Agent topology.`);
  }
  return {
    exists: true,
    health: container.State?.Health?.Status ?? "none",
    imageId: String(container.Image ?? "").slice(0, 19),
    running: container.State?.Running === true,
  };
}

function inspectContainer(name) {
  const result = spawnSync("docker", ["inspect", name], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed[0] : undefined;
}

async function waitForPostgres(name) {
  const environment = containerEnvironment(name);
  await waitFor(`${name} PostgreSQL`, () => spawnSync("docker", [
    "exec", name, "pg_isready",
    "-U", environment.POSTGRES_USER,
    "-d", environment.POSTGRES_DB,
  ], { stdio: "ignore" }).status === 0, 120_000);
}

async function waitForHttp(url, label) {
  await waitFor(label, async () => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok;
    } catch {
      return false;
    }
  }, 120_000);
}

async function waitForClamAv() {
  await waitFor("ClamAV", () => new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 53310 });
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => socket.write("zPING\0"));
    socket.once("data", (data) => finish(data.toString("utf8").includes("PONG")));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("close", () => finish(false));
  }), 1_800_000);
}

async function configureBucket() {
  const environment = containerEnvironment(containers.minio);
  const client = new S3Client({
    endpoint: "http://127.0.0.1:59000",
    forcePathStyle: true,
    region: "us-east-1",
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: environment.MINIO_ROOT_USER,
      secretAccessKey: environment.MINIO_ROOT_PASSWORD,
    },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET })).catch(async () => {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    });
    await verifyMinioCors(client);
  } finally {
    client.destroy();
  }
}

async function verifyMinioCors(client) {
  const origin = "https://agent.local";
  const key = `infrastructure-probes/cors-${Date.now()}`;
  const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 60 });
  const preflight = await fetch(url, {
    headers: {
      "access-control-request-headers": "content-type",
      "access-control-request-method": "PUT",
      origin,
    },
    method: "OPTIONS",
  });
  assertCorsResponse(preflight, origin, "MinIO preflight");
  const upload = await fetch(url, {
    body: new Uint8Array([0]),
    headers: { "content-type": "application/octet-stream", origin },
    method: "PUT",
  });
  if (!upload.ok) throw new Error(`MinIO CORS upload probe returned ${upload.status}.`);
  assertCorsResponse(upload, origin, "MinIO upload");
  if (!upload.headers.get("etag")) throw new Error("MinIO did not expose an ETag on the upload response.");
  const exposed = upload.headers.get("access-control-expose-headers")?.toLowerCase() ?? "";
  if (!exposed.split(",").map((value) => value.trim()).some((value) => value === "*" || value === "etag")) {
    throw new Error("MinIO CORS does not expose the ETag response header.");
  }
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

function assertCorsResponse(response, origin, label) {
  if (!response.ok) throw new Error(`${label} returned ${response.status}.`);
  const allowed = response.headers.get("access-control-allow-origin");
  if (allowed !== "*" && allowed !== origin) {
    throw new Error(`${label} did not allow the browser origin.`);
  }
}

async function resolvePublicOrigin() {
  const configured = process.env.AGENT_LOCAL_PRODUCTION_PUBLIC_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;
  try {
    const response = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5_000) });
    const address = response.ok ? (await response.text()).trim() : "";
    if (/^[0-9a-f:.]+$/iu.test(address)) {
      return `http://${address.includes(":") ? `[${address}]` : address}:3100`;
    }
  } catch {
    // The loopback origin below remains valid for an offline staging host.
  }
  return "http://127.0.0.1:3100";
}

function containerEnvironment(name) {
  const container = inspectContainer(name);
  if (!container) throw new Error(`Docker container ${name} does not exist.`);
  return Object.fromEntries((container.Config?.Env ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function bootstrapDatabases() {
  const agentDatabaseUrl = postgresUrl(containers.agentDatabase, 56432);
  const workflowDatabaseUrl = postgresUrl(containers.workflowDatabase, 56433);
  execFileSync("npx", ["--no-install", "--package=@workflow/world-postgres", "bootstrap"], {
    cwd: process.cwd(),
    env: { ...process.env, WORKFLOW_POSTGRES_URL: workflowDatabaseUrl },
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["scripts/migrate-agent-data.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_DATABASE_SCHEMA: "open_agent", AGENT_DATABASE_URL: agentDatabaseUrl },
    stdio: "inherit",
  });
}

function postgresUrl(container, port) {
  const environment = containerEnvironment(container);
  const url = new URL(`postgresql://127.0.0.1:${port}/${environment.POSTGRES_DB || "postgres"}`);
  url.username = environment.POSTGRES_USER || "postgres";
  url.password = environment.POSTGRES_PASSWORD || "";
  return url.toString();
}

async function waitFor(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs} ms.`);
}

function secret() {
  return randomBytes(36).toString("base64url");
}

function assertDockerAvailable() {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    throw new Error("A reachable Docker daemon is required.");
  }
}
