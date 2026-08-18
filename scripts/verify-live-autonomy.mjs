import { createHmac, randomUUID } from "node:crypto";

const serviceUrl = (process.env.AGENT_LIVE_E2E_BASE_URL?.trim() || "http://127.0.0.1:3100")
  .replace(/\/$/u, "");
const previewOrigin = (process.env.AGENT_LIVE_E2E_PREVIEW_ORIGIN?.trim() || serviceUrl)
  .replace(/\/$/u, "");
const runDurationMs = boundedInteger(
  "AGENT_LIVE_E2E_RUN_DURATION_MS",
  300_000,
  30_000,
  600_000,
);
const timeoutMs = boundedInteger(
  "AGENT_LIVE_E2E_TIMEOUT_MS",
  runDurationMs + 60_000,
  runDurationMs,
  660_000,
);
const maxInputTokens = boundedInteger(
  "AGENT_LIVE_E2E_MAX_INPUT_TOKENS",
  500_000,
  100_000,
  2_000_000,
);
const marker = `OPEN_AGENT_LIVE_${Date.now()}_${randomUUID().slice(0, 8)}`;
const idempotencyKey = `live-autonomy:${marker}`;
const request = {
  idempotencyKey,
  message: [
    "Complete this task autonomously using the sandbox and return a finished result.",
    "Create a small static company website under /workspace/site.",
    `The visible page title must contain the exact verification marker ${marker}.`,
    "Include index.html and styles.css, verify both files exist and index.html contains the marker,",
    "then call publish_preview with root site and entrypoint index.html.",
    "Do not only explain the steps and do not stop before publishing the preview.",
  ].join(" "),
  metadata: { verification: "live-autonomy-preview" },
  policy: {
    executionMode: "automation",
    limits: {
      maxDurationMs: runDurationMs,
      maxInputTokens,
      maxModelCalls: 20,
      maxOutputTokens: 10_000,
      maxToolCalls: 32,
      maxTurns: 1,
    },
  },
  profile: { profileId: "general-purpose", version: "0.1.0" },
};

const started = await api("POST", "/api/agent/runs", request, 202);
const runId = started.run?.runId;
assert(typeof runId === "string", "The live AgentRun did not return a run id.");

const replayed = await api("POST", "/api/agent/runs", request, 200);
assert(replayed.disposition === "replayed", "The live AgentRun was not idempotently replayed.");
assert(replayed.run?.runId === runId, "Idempotent replay changed the live AgentRun id.");

const run = await pollRun(runId);
assert(
  run.status === "completed",
  `The live autonomy run ended as ${run.status}: ${run.failure?.message || "unknown failure"}`,
);
assert(run.usage?.inputTokens > 0, "The live autonomy run did not project input usage.");
assert(run.usage?.outputTokens > 0, "The live autonomy run did not project output usage.");
assert(run.usage?.steps > 0, "The live autonomy run did not project model steps.");

const events = await readAllEvents(runId);
const serialized = JSON.stringify(events);
assert(serialized.includes("publish_preview"), "The Agent never requested publish_preview.");
assert(
  serialized.includes("write_file") || serialized.includes("bash"),
  "The Agent never used a sandbox file or Shell tool.",
);

const outputs = events
  .filter((event) => event.type === "tool.completed" && event.data?.status === "completed")
  .map((event) => event.data?.result?.output)
  .filter((output) => output && typeof output === "object");
const preview = outputs.find(
  (output) => output.kind === "website-preview" && typeof output.url === "string",
);
assert(preview, "The Agent did not return a completed website preview.");
assert(typeof preview.previewId === "string", "The website preview did not return an id.");

const publishedUrl = new URL(preview.url);
const accessUrl = new URL(`${publishedUrl.pathname}${publishedUrl.search}`, `${previewOrigin}/`);
const previewResponse = await fetch(accessUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
assert(previewResponse.status === 200, `The signed preview returned ${previewResponse.status}.`);
assert(
  previewResponse.headers.get("content-type")?.startsWith("text/html"),
  "The signed preview did not return HTML.",
);
const html = await previewResponse.text();
assert(html.includes(marker), "The published website does not contain the requested marker.");

console.log(JSON.stringify({
  eventCount: events.length,
  idempotency: replayed.disposition,
  ok: true,
  previewId: preview.previewId,
  previewVerified: true,
  runId,
  usage: run.usage,
}));

async function pollRun(targetRunId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await api(
      "GET",
      `/api/agent/runs/${encodeURIComponent(targetRunId)}`,
      undefined,
      200,
    );
    if (["completed", "failed", "cancelled", "submission-ambiguous"].includes(payload.run.status)) {
      return payload.run;
    }
    if (["waiting-authorization", "waiting-input"].includes(payload.run.status)) {
      throw new Error(`The unattended live AgentRun stopped in ${payload.run.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The live AgentRun did not settle within ${timeoutMs}ms.`);
}

async function readAllEvents(targetRunId) {
  const events = [];
  let cursor = 0;
  for (let page = 0; page < 100; page += 1) {
    const payload = await api(
      "GET",
      `/api/agent/runs/${encodeURIComponent(targetRunId)}/events?after=${cursor}`,
      undefined,
      200,
    );
    assert(Array.isArray(payload.events), "The Agent event page is invalid.");
    events.push(...payload.events);
    const nextCursor = payload.nextCursor;
    assert(Number.isSafeInteger(nextCursor) && nextCursor >= cursor, "The Agent event cursor is invalid.");
    if (nextCursor === cursor || payload.events.length === 0) return events;
    cursor = nextCursor;
  }
  throw new Error("The Agent event stream exceeded 100 pages.");
}

async function api(method, path, body, expectedStatus) {
  const response = await fetch(`${serviceUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${createToken()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 120_000)),
  });
  const payload = await response.json().catch(() => undefined);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} returned ${response.status}, expected ${expectedStatus}: ${
        payload?.message || payload?.error || "unknown error"
      }`,
    );
  }
  return payload;
}

function createToken() {
  const secret = required("AGENT_HOST_JWT_SECRET");
  const issuer = required("AGENT_HOST_JWT_ISSUER");
  const audience = required("AGENT_HOST_JWT_AUDIENCE");
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    actorType: "service",
    aud: audience,
    exp: now + Math.max(300, Math.ceil(timeoutMs / 1_000) + 60),
    iat: now,
    iss: issuer,
    jti: randomUUID(),
    scope: ["agent:runs"],
    sub: "live-autonomy-verifier",
    tenantId: "live-autonomy-verification",
  });
  const input = `${header}.${payload}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
