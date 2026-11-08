import { createHash } from "node:crypto";
import { Client, type SessionStreamEvent } from "eve/client";
import type {
  AgentRunInputResponse,
  AgentRunPolicy,
} from "@oworker/open-agent-contracts/agent-run";
import type { ParsedStartAgentRun } from "./input.ts";

const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_EVENT_READ_LIMIT = 200;

export type EveAgentSessionRef = {
  readonly sessionId: string;
};

export type EveResetStatus = "no_active_session" | "reset";

export function isAgentRuntimeConfigured(): boolean {
  return Boolean(process.env.AGENT_RUNTIME_URL?.trim());
}

export async function startEveAgentRun(
  input: ParsedStartAgentRun,
  runId: string,
  accessToken: string,
): Promise<EveAgentSessionRef> {
  const created = await createClient(
    accessToken,
    runId,
    input.correlationId,
    input.profile,
    input.policy,
  ).sessions.create({
    ...(input.clientContext ? { clientContext: input.clientContext } : {}),
    message: input.message,
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    signal: AbortSignal.timeout(runtimeRequestTimeoutMs()),
    streamReconnectPolicy: { reconnect: false },
  });
  return { sessionId: created.delivery.sessionId };
}

export async function readEveAgentEvents(
  runId: string,
  correlationId: string,
  sessionId: string,
  accessToken: string,
  startIndex = 0,
  limit = DEFAULT_EVENT_READ_LIMIT,
): Promise<readonly SessionStreamEvent[]> {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new RangeError("Eve event start index must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Eve event read limit must be an integer from 1 to 1000.");
  }

  const events: SessionStreamEvent[] = [];
  const session = createClient(accessToken, runId, correlationId).sessions.attach(sessionId);
  // Eve owns wire decoding, reconnection and source-line framing. A page may
  // exceed its fact budget to preserve the final committed line atomically.
  for await (const event of session.stream({
    startIndex,
    follow: false,
    signal: AbortSignal.timeout(runtimeRequestTimeoutMs()),
  })) {
    events.push(event);
    if (events.length >= limit && event.meta.endOfLine !== false) break;
  }
  return events;
}

export async function cancelEveAgentRun(
  runId: string,
  correlationId: string,
  sessionId: string,
  accessToken: string,
): Promise<"accepted" | "no_active_turn"> {
  const session = createClient(accessToken, runId, correlationId).sessions.attach(sessionId);
  await session.cancel({ signal: AbortSignal.timeout(runtimeRequestTimeoutMs()) });
  return "accepted";
}

export async function respondEveAgentRun(
  runId: string,
  correlationId: string,
  sessionId: string,
  accessToken: string,
  inputResponses: readonly AgentRunInputResponse[],
): Promise<EveAgentSessionRef> {
  const session = createClient(accessToken, runId, correlationId).sessions.attach(sessionId);
  const response = await session.respond(inputResponses.map(({ requestId, ...answer }) => ({ interactionId: requestId, ...answer })), {
    signal: AbortSignal.timeout(runtimeRequestTimeoutMs()),
    streamReconnectPolicy: { reconnect: false },
  });
  return { sessionId: response.sessionId };
}

export async function resetEveAgentRun(
  runId: string,
  correlationId: string,
  sessionId: string,
  accessToken: string,
): Promise<EveResetStatus> {
  const session = createClient(accessToken, runId, correlationId).sessions.attach(sessionId);
  const startIndex = session.state.streamIndex;
  const signal = AbortSignal.timeout(runtimeRequestTimeoutMs());
  const delivery = await session.reset({ signal });
  await waitForReset(session.stream({ startIndex, follow: true, signal }), delivery.deliveryId);
  return "reset";
}

export async function resetEveSession(
  sessionId: string,
  accessToken: string,
  correlationId: string,
): Promise<EveResetStatus> {
  // Eve validates x-agent-run-id on every channel request. Deletion is a
  // session-level control, so derive a stable, valid AgentRun-shaped id rather
  // than sending a human-readable control label that Eve rejects with 500.
  const controlRunId = `arun_${createHash("sha256").update(`sandbox-delete:${sessionId}`).digest("hex").slice(0, 32)}`;
  const session = createClient(accessToken, controlRunId, correlationId).sessions.attach(sessionId);
  const startIndex = session.state.streamIndex;
  const signal = AbortSignal.timeout(runtimeRequestTimeoutMs());
  const delivery = await session.reset({ signal });
  await waitForReset(session.stream({ startIndex, follow: true, signal }), delivery.deliveryId);
  return "reset";
}

async function waitForReset(
  events: AsyncIterable<SessionStreamEvent>,
  deliveryId: string,
): Promise<void> {
  let sessionEnded = false;
  let deliverySettled = false;
  const eventTypes: string[] = [];
  for await (const event of events) {
    eventTypes.push(event.type);
    if (event.type === "session.ended") sessionEnded = true;
    if (event.type === "delivery.settled" && event.data.deliveryId === deliveryId) {
      deliverySettled = true;
    }
    if (sessionEnded || (deliverySettled && event.meta.endOfLine !== false)) break;
  }
  if (!sessionEnded && !deliverySettled) {
    throw new Error(`Eve reset delivery ended without settling or ending its session (events: ${eventTypes.join(", ") || "none"}).`);
  }
}

function createClient(
  accessToken: string,
  runId: string,
  correlationId: string,
  profile?: { readonly profileId: string; readonly version: string },
  policy?: AgentRunPolicy,
  query?: Readonly<Record<string, string>>,
): Client {
  const host = new URL(normalizeAgentRuntimeHost(process.env.AGENT_RUNTIME_URL));
  for (const [name, value] of Object.entries(query ?? {})) host.searchParams.set(name, value);
  const hostHeader = process.env.AGENT_RUNTIME_HOST_HEADER?.trim();
  return new Client({
    auth: { bearer: accessToken },
    headers: {
      ...(hostHeader ? { host: hostHeader } : {}),
      "x-agent-correlation-id": correlationId,
      "x-agent-run-id": runId,
      ...(profile
        ? {
            "x-agent-profile-id": profile.profileId,
            "x-agent-profile-version": profile.version,
          }
        : {}),
      ...(policy ? { "x-agent-run-policy": Buffer.from(JSON.stringify(policy)).toString("base64url") } : {}),
    },
    baseUrl: host.toString(),
    redirect: "error",
  });
}

export function normalizeAgentRuntimeHost(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) {
    throw new Error("AGENT_RUNTIME_URL is required for the headless AgentRun API.");
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("AGENT_RUNTIME_URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AGENT_RUNTIME_URL must be an absolute HTTP(S) URL.");
  }

  // Eve Client appends /eve/v1 itself. Accept and repair the common endpoint-form
  // configuration so hosts never submit to /eve/v1/eve/v1/session.
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/eve/v1")) {
    url.pathname = pathname.slice(0, -"/eve/v1".length) || "/";
  }
  url.hash = "";
  return url.toString();
}

function runtimeRequestTimeoutMs(): number {
  const value = process.env.AGENT_RUNTIME_REQUEST_TIMEOUT_MS?.trim();
  if (!value) return DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error("AGENT_RUNTIME_REQUEST_TIMEOUT_MS must be an integer from 1000 to 120000.");
  }
  return timeout;
}
