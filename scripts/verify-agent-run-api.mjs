import { createHmac } from "node:crypto";

const baseUrl = process.env.AGENT_RUN_TEST_BASE_URL?.trim() || "http://127.0.0.1:3101";
const secret = required("AGENT_RUN_TEST_JWT_SECRET");
const issuer = process.env.AGENT_RUN_TEST_JWT_ISSUER?.trim() || "https://muses.local.test";
const audience = process.env.AGENT_RUN_TEST_JWT_AUDIENCE?.trim() || "open-agent";
const userToken = signToken({ actorType: "user", scope: ["agent:runs"], sub: "run-test-user", tenantId: "run-test-tenant" });
const otherUserToken = signToken({ actorType: "user", scope: ["agent:runs"], sub: "other-user", tenantId: "run-test-tenant" });
const otherTenantToken = signToken({ actorType: "user", scope: ["agent:runs"], sub: "run-test-user", tenantId: "other-tenant" });

const unauthorized = await fetch(`${baseUrl}/api/agent/runs`, { method: "POST" });
assert(unauthorized.status === 401, `Expected unauthenticated status 401, received ${unauthorized.status}.`);

const idempotencyKey = `contract-${Date.now()}`;
const request = {
  idempotencyKey,
  message: process.env.AGENT_RUN_TEST_MESSAGE || "Return the requested structured result.",
  outputSchema: {
    additionalProperties: false,
    properties: { answer: { type: "string" } },
    required: ["answer"],
    type: "object",
  },
  profile: { profileId: "general-purpose", version: "0.1.0" },
};
const started = await jsonRequest("POST", "/api/agent/runs", userToken, request, 202);
const runId = started.run?.runId;
assert(typeof runId === "string", "The start response did not include a runId.");

const replay = await jsonRequest("POST", "/api/agent/runs", userToken, request, 200);
assert(replay.disposition === "replayed", "The identical request was not replayed.");
assert(replay.run?.runId === runId, "The replay created a different AgentRun.");

await jsonRequest(
  "POST",
  "/api/agent/runs",
  userToken,
  { ...request, message: "A different request." },
  409,
);
await jsonRequest("GET", `/api/agent/runs/${runId}`, otherUserToken, undefined, 404);
await jsonRequest("GET", `/api/agent/runs/${runId}`, otherTenantToken, undefined, 404);

const completed = await pollRun(runId, userToken, ["completed", "failed"]);
assert(completed.status === "completed", `Structured AgentRun ended as ${completed.status}.`);
assert(completed.result?.kind === "json", "The structured AgentRun did not return JSON.");
assert(completed.result?.value?.answer === "STRUCTURED_READY", "The structured result was not projected.");
assert(completed.usage?.inputTokens === 23, "Input token usage was not projected.");
assert(completed.usage?.outputTokens === 7, "Output token usage was not projected.");
assert(completed.usage?.cacheReadTokens === 4, "Cache-read usage was not projected.");
assert(completed.usage?.cacheWriteTokens === 2, "Cache-write usage was not projected.");

const allEvents = await jsonRequest("GET", `/api/agent/runs/${runId}/events?after=0`, userToken, undefined, 200);
assert(Array.isArray(allEvents.events) && allEvents.events.length > 0, "No AgentRun events were returned.");
assert(allEvents.nextCursor === allEvents.events.length, "The initial event cursor is invalid.");
const emptyPage = await jsonRequest(
  "GET",
  `/api/agent/runs/${runId}/events?after=${allEvents.nextCursor}`,
  userToken,
  undefined,
  200,
);
assert(emptyPage.events.length === 0, "An exhausted event cursor returned duplicate events.");

const slow = await jsonRequest(
  "POST",
  "/api/agent/runs",
  userToken,
  {
    idempotencyKey: `cancel-${Date.now()}`,
    message: "WAIT_FOR_CANCEL",
    profile: { profileId: "general-purpose", version: "0.1.0" },
  },
  202,
);
const slowRunId = slow.run?.runId;
assert(typeof slowRunId === "string", "The cancellation run did not include a runId.");
await new Promise((resolve) => setTimeout(resolve, 150));
const cancelled = await jsonRequest("DELETE", `/api/agent/runs/${slowRunId}`, userToken, undefined, 202);
assert(
  ["accepted", "no_active_turn"].includes(cancelled.cancellation),
  `Unexpected cancellation outcome ${cancelled.cancellation}.`,
);
assert(typeof cancelled.run?.cancellationRequestedAt === "string", "Cancellation was not persisted.");
const duplicateCancel = await jsonRequest(
  "DELETE",
  `/api/agent/runs/${slowRunId}`,
  userToken,
  undefined,
  202,
);
assert(
  ["already_requested", "terminal"].includes(duplicateCancel.cancellation),
  "Repeated cancellation was not idempotent.",
);

console.log(JSON.stringify({
  cancellation: cancelled.cancellation,
  eventCount: completed.eventCount,
  idempotency: replay.disposition,
  isolation: "enforced",
  result: completed.result.value,
  status: completed.status,
  usage: completed.usage,
}));

async function pollRun(runId, token, terminalStatuses) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await jsonRequest("GET", `/api/agent/runs/${runId}`, token, undefined, 200);
    if (terminalStatuses.includes(response.run.status)) return response.run;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`AgentRun ${runId} did not settle before the verification deadline.`);
}

async function jsonRequest(method, path, token, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${method} ${path} returned a non-JSON response with status ${response.status}.`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} returned ${response.status}, expected ${expectedStatus}: ${payload.error || "unknown error"}`);
  }
  return payload;
}

function signToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ ...claims, aud: audience, exp: now + 300, iat: now, iss: issuer });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
