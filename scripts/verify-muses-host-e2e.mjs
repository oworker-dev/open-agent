import { createHmac, randomUUID } from "node:crypto";
import { parseAgentRuntimeConfigSnapshot } from "@oworker/open-agent-contracts/runtime-config";

const configuration = readConfiguration();
const serviceUrl = configuration.serviceUrl;
const userId = configuration.userId;
const workspaceId = configuration.workspaceId;
const projectId = configuration.projectId;
const canvasId = process.env.MUSES_E2E_CANVAS_ID?.trim();
const deploymentId = configuration.deploymentId;
const agentNodeId = process.env.MUSES_E2E_AGENT_NODE_ID?.trim() || "agent-run-1";
const workflowInputId = process.env.MUSES_E2E_WORKFLOW_INPUT_ID?.trim() || "prompt";
const workflowMessage = process.env.MUSES_E2E_WORKFLOW_MESSAGE?.trim() || "Return the word BRIDGE_READY.";
const runtimeConfig = configuration.runtimeConfig;
const runDurationMs = Math.min(
  runtimeConfig.limits?.maxDurationMs ?? 600_000,
  600_000,
);
const actor = {
  userId,
  workspaceId,
  actorType: "service",
  runtimeConfig,
  scope: { projectId, ...(canvasId ? { canvasId } : {}) },
};
const idempotencyKey = `muses-host-e2e:${Date.now()}:${randomUUID()}`;
const request = {
  idempotencyKey,
  message: `MUSES_HOST_E2E: This is an exact Host contract verification. Use only host_capabilities and host_invoke for the requested Host operations; do not use web_fetch, shell, filesystem, or other generic tools as substitutes. Inspect the canvas, invoke Workflow deployment ${deploymentId} with inputs ${JSON.stringify({ [workflowInputId]: { valueType: "text", value: workflowMessage } })}, and wait for completion using workflow.run.wait only. After it completes, call canvas.item.put with refId equal to the Workflow runId, kind "workflow", and a concise title and position. Inspect the canvas again and report the result. Do not call generic tools while waiting.`,
  profile: {
    profileId: runtimeConfig.profile.id,
    version: runtimeConfig.profile.version,
  },
  policy: {
    hostCapabilities: [
      "canvas.inspect",
      "canvas.item.put",
      "workflow.invoke",
      "workflow.run.inspect",
      "workflow.run.wait",
    ],
    limits: {
      maxTurns: 1,
      maxModelCalls: 16,
      maxToolCalls: 16,
      maxInputTokens: 200_000,
      maxOutputTokens: 20_000,
      maxDurationMs: runDurationMs,
    },
  },
  metadata: { verification: "muses-host-workflow-canvas-e2e" },
};

const started = await api("POST", "/api/agent/runs", request, 202);
const replay = await api("POST", "/api/agent/runs", request, 200);
assert(replay.disposition === "replayed", "AgentRun idempotency replay was not reported.");
assert(replay.run.runId === started.run.runId, "AgentRun replay returned another run.");

const run = await poll(started.run.runId);
assert(run.status === "completed", `AgentRun ended as ${run.status}: ${run.failure?.message || "unknown failure"}`);
assert(
  run.result?.kind === "text" && run.result.value.trim().length > 0,
  "Agent did not return a final Host verification message.",
);
assert(run.usage.inputTokens > 0 && run.usage.outputTokens > 0 && run.usage.steps > 0, "Agent usage was not projected.");

const eventPayload = await api("GET", `/api/agent/runs/${encodeURIComponent(run.runId)}/events?after=0`, undefined, 200);
const serialized = JSON.stringify(eventPayload.events);
for (const capability of ["canvas.inspect", "workflow.invoke", "workflow.run.wait", "canvas.item.put"]) {
  assert(serialized.includes(capability), `Agent event stream is missing ${capability}.`);
}
assert(serialized.includes("completed"), "Agent never observed a completed Workflow run.");
assert(eventPayload.events.some((event) => event.type === "tool.completed"), "Host tool completion was not projected.");
const hostResults = eventPayload.events
  .filter((event) => event.type === "tool.completed" && event.data?.status === "completed")
  .map((event) => event.data?.result?.output)
  .filter((output) => output?.capability);
const workflowInspection = hostResults.find(
  (output) =>
    output.capability === "workflow.run.wait" &&
    output.output?.status === "completed",
);
assert(workflowInspection, "Platform Agent did not observe a completed Workflow run.");
assert(
  workflowInspection.output.completedNodeIds?.includes(agentNodeId),
  "The Workflow Agent node did not complete.",
);
assert(
  workflowInspection.output.outputs?.result?.value === "BRIDGE_READY",
  "The Workflow Agent node result was not projected.",
);
const workflowRunId = workflowInspection.output.runId;
const canvasPut = hostResults.find(
  (output) =>
    output.capability === "canvas.item.put" &&
    output.output?.item?.refId === workflowRunId,
);
assert(canvasPut, "The completed Workflow run was not placed on the canvas.");
const finalCanvas = hostResults
  .filter((output) => output.capability === "canvas.inspect")
  .at(-1);
const canvasItem = canvasPut?.output?.item;
assert(
  finalCanvas?.output?.canvas?.items?.some(
    (item) => item.kind === "workflow" && item.refId === workflowRunId,
  ) || (canvasItem?.kind === "workflow" && canvasItem.refId === workflowRunId),
  "The canvas write was not confirmed with the Workflow run.",
);

console.log(JSON.stringify({
  ok: true,
  agentRunId: run.runId,
  eventCount: run.eventCount,
  idempotency: replay.disposition,
  result: run.result.value,
  usage: run.usage,
}));

async function poll(runId) {
  const deadline = Date.now() + runDurationMs + 60_000;
  while (Date.now() < deadline) {
    const payload = await api("GET", `/api/agent/runs/${encodeURIComponent(runId)}`, undefined, 200);
    if (["completed", "failed", "cancelled"].includes(payload.run.status)) return payload.run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `AgentRun did not settle within ${Math.ceil((runDurationMs + 60_000) / 1_000)} seconds.`,
  );
}

async function api(method, path, body, expectedStatus) {
  const response = await fetch(`${serviceUrl}${path}`, {
    method,
    headers: {
      // Long-running AgentRuns can outlive the short Host token TTL. Refresh
      // the token for every request so polling never turns into a false 401.
      authorization: `Bearer ${createToken(actor)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => undefined);
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} returned ${response.status}: ${payload?.message || "unknown error"}`);
  }
  return payload;
}

function createToken(actor) {
  const secret = required("MUSES_AGENT_HOST_JWT_SECRET");
  const issuer = required("MUSES_AGENT_HOST_JWT_ISSUER");
  const audience = required("MUSES_AGENT_HOST_JWT_AUDIENCE");
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    actorType: actor.actorType,
    aud: audience,
    exp: now + 300,
    iat: now,
    iss: issuer,
    jti: randomUUID(),
    sub: actor.userId,
    tenantId: actor.workspaceId,
    scope: ["agent:runs"],
    agentHostScope: JSON.stringify(actor.scope),
    agentRuntimeConfig: JSON.stringify(actor.runtimeConfig),
  });
  const input = `${header}.${payload}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

function parseRuntimeConfig(value) {
  try {
    return parseAgentRuntimeConfigSnapshot(JSON.parse(value));
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`MUSES_E2E_RUNTIME_CONFIG_JSON must contain a valid Agent Runtime Config snapshot.${detail}`);
  }
}

function readConfiguration(environment = process.env) {
  const requiredNames = [
    "MUSES_AGENT_SERVICE_URL",
    "MUSES_E2E_USER_ID",
    "MUSES_E2E_WORKSPACE_ID",
    "MUSES_E2E_PROJECT_ID",
    "MUSES_E2E_DEPLOYMENT_ID",
    "MUSES_E2E_RUNTIME_CONFIG_JSON",
    "MUSES_AGENT_HOST_JWT_SECRET",
    "MUSES_AGENT_HOST_JWT_ISSUER",
    "MUSES_AGENT_HOST_JWT_AUDIENCE",
  ];
  const missing = requiredNames.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Muses Host E2E preflight failed. Missing required environment variables: ${missing.join(", ")}.`);
  }
  const serviceUrl = environment.MUSES_AGENT_SERVICE_URL.trim().replace(/\/+$/, "");
  let parsedServiceUrl;
  try {
    parsedServiceUrl = new URL(serviceUrl);
  } catch {
    throw new Error("MUSES_AGENT_SERVICE_URL must be an absolute HTTP(S) URL.");
  }
  if (parsedServiceUrl.protocol !== "http:" && parsedServiceUrl.protocol !== "https:") {
    throw new Error("MUSES_AGENT_SERVICE_URL must use HTTP or HTTPS.");
  }
  if (parsedServiceUrl.username || parsedServiceUrl.password) {
    throw new Error("MUSES_AGENT_SERVICE_URL must not contain embedded credentials.");
  }
  if (parsedServiceUrl.search || parsedServiceUrl.hash) {
    throw new Error("MUSES_AGENT_SERVICE_URL must not contain a query or fragment.");
  }
  const secret = environment.MUSES_AGENT_HOST_JWT_SECRET.trim();
  if (Buffer.byteLength(secret) < 32) {
    throw new Error("MUSES_AGENT_HOST_JWT_SECRET must contain at least 32 bytes.");
  }
  return {
    deploymentId: environment.MUSES_E2E_DEPLOYMENT_ID.trim(),
    projectId: environment.MUSES_E2E_PROJECT_ID.trim(),
    runtimeConfig: parseRuntimeConfig(environment.MUSES_E2E_RUNTIME_CONFIG_JSON),
    serviceUrl,
    userId: environment.MUSES_E2E_USER_ID.trim(),
    workspaceId: environment.MUSES_E2E_WORKSPACE_ID.trim(),
  };
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
