import { createHash } from "node:crypto";
import { Client, ClientError, type MessageStreamEvent } from "eve/client";
import type { AgentRunPolicy } from "@oworker/open-agent-contracts/agent-run";
import type { ParsedStartAgentRun } from "./input";

const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_EVENT_READ_LIMIT = 200;
const MAX_BOUNDED_EVENT_RECONNECTS = 8;
const MAX_BOUNDED_EVENT_TRANSPORT_RETRIES = 3;

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
  return { sessionId: created.response.sessionId };
}

export async function readEveAgentEvents(
  runId: string,
  correlationId: string,
  sessionId: string,
  accessToken: string,
  startIndex = 0,
  limit = DEFAULT_EVENT_READ_LIMIT,
): Promise<readonly MessageStreamEvent[]> {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new RangeError("Eve event start index must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Eve event read limit must be an integer from 1 to 1000.");
  }

  // Eve keeps a bounded response alive for reconnectable consumers even after
  // it has emitted the current durable tail. The generic ClientSession stream
  // intentionally waits for the socket to close, which is correct for a live
  // UI stream but can leave a headless AgentRun event page hanging forever.
  // Read the tail header directly and cancel the response as soon as the
  // absolute cursor reaches it, reconnecting only when the tail advances.
  const events: MessageStreamEvent[] = [];
  let cursor = startIndex;
  let attempts = 0;
  let transportFailures = 0;
  while (events.length < limit) {
    let page: Awaited<ReturnType<typeof readBoundedEventPage>>;
    try {
      page = await readBoundedEventPage({
        accessToken,
        correlationId,
        cursor,
        runId,
        sessionId,
      });
      transportFailures = 0;
    } catch (error) {
      if (!isRetryableRuntimeReadError(error) || transportFailures >= MAX_BOUNDED_EVENT_TRANSPORT_RETRIES) {
        throw error;
      }
      transportFailures += 1;
      await sleep(runtimeReadRetryDelay(transportFailures));
      continue;
    }
    events.push(...page.events.slice(0, limit - events.length));
    cursor += page.events.length;
    if (events.length >= limit || cursor > page.tailIndex) return events;
    attempts += 1;
    if (attempts > MAX_BOUNDED_EVENT_RECONNECTS) {
      throw new Error("Eve bounded event stream did not reach its declared durable tail.");
    }
  }
  return events;
}

function isRetryableRuntimeReadError(error: unknown): boolean {
  if (error instanceof ClientError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return true;
  return error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError;
}

function runtimeReadRetryDelay(attempt: number): number {
  // Keep reconnects quick for the UI while avoiding a hot loop during a
  // rolling runtime restart. Jitter prevents many browser workers from
  // reconnecting in lockstep after the same upstream failure.
  const base = Math.min(1_500, 100 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBoundedEventPage(input: {
  readonly accessToken: string;
  readonly correlationId: string;
  readonly cursor: number;
  readonly runId: string;
  readonly sessionId: string;
}): Promise<{ readonly events: readonly MessageStreamEvent[]; readonly tailIndex: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtimeRequestTimeoutMs());
  try {
    const response = await fetch(boundedEventUrl(input.sessionId, input.cursor), {
      cache: "no-store",
      headers: runtimeHeaders(input.accessToken, input.runId, input.correlationId),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ClientError(
        response.status,
        "Eve bounded event stream request failed.",
        response.headers,
      );
    }
    const rawTail = response.headers.get("x-eve-stream-tail-index");
    const tailIndex = rawTail === null ? NaN : Number(rawTail);
    if (!Number.isSafeInteger(tailIndex) || tailIndex < input.cursor - 1) {
      controller.abort();
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Eve bounded event stream requires the server to report the x-eve-stream-tail-index header.");
    }
    // The caller is already at or beyond the durable tail. Eve may keep this
    // empty response alive for future events, but a bounded page must return
    // immediately and leave live-following to the UI transport.
    if (tailIndex < input.cursor) {
      controller.abort();
      void response.body?.cancel().catch(() => undefined);
      return { events: [], tailIndex };
    }
    if (!response.body) return { events: [], tailIndex };

    const events: MessageStreamEvent[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reachedTail = false;
    try {
      while (!reachedTail) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = parseEvent(line);
          events.push(event);
          if (input.cursor + events.length - 1 >= tailIndex) {
            reachedTail = true;
            break;
          }
        }
      }
      if (!reachedTail) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const event = parseEvent(buffer);
          events.push(event);
        }
      }
    } finally {
      // The response is deliberately cancelled even when Eve leaves the
      // connection open. This releases the socket and makes the next page
      // request deterministic under load.
      controller.abort();
      void reader.cancel().catch(() => undefined);
    }
    return { events, tailIndex };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function boundedEventUrl(sessionId: string, startIndex: number): string {
  const host = new URL(normalizeAgentRuntimeHost(process.env.AGENT_RUNTIME_URL));
  const path = `eve/v1/session/${encodeURIComponent(sessionId)}/stream`;
  const url = new URL(path, host);
  url.searchParams.set("follow", "0");
  url.searchParams.set("includeTailIndex", "1");
  url.searchParams.set("startIndex", String(startIndex));
  return url.toString();
}

function runtimeHeaders(
  accessToken: string,
  runId: string,
  correlationId: string,
): Record<string, string> {
  const hostHeader = process.env.AGENT_RUNTIME_HOST_HEADER?.trim();
  return {
    authorization: `Bearer ${accessToken}`,
    "x-agent-correlation-id": correlationId,
    "x-agent-run-id": runId,
    ...(hostHeader ? { host: hostHeader } : {}),
  };
}

function parseEvent(line: string): MessageStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Eve bounded event stream returned invalid JSON.");
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    throw new Error("Eve bounded event stream returned an invalid event.");
  }
  return value as MessageStreamEvent;
}

export async function cancelEveAgentRun(
  runId: string,
  correlationId: string,
  sessionId: string,
  accessToken: string,
): Promise<"accepted" | "no_active_turn"> {
  const session = createClient(accessToken, runId, correlationId).sessions.attach(sessionId);
  return (await session.cancel()).status;
}

export async function resetEveAgentRun(
  runId: string,
  correlationId: string,
  sessionId: string,
  accessToken: string,
): Promise<EveResetStatus> {
  const session = createClient(accessToken, runId, correlationId).sessions.attach(sessionId);
  return (await session.reset()).status;
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
  return (await session.reset()).status;
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
    host: host.toString(),
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
