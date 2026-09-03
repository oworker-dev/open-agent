import type { AgentMailboxRuntime } from "./service.ts";
import { AgentMailboxAdmissionError } from "./service.ts";
import type { MessageStreamEvent } from "eve/client";
import { signMailboxDispatchBody } from "../../agent/lib/mailbox-dispatch-auth.ts";
import { normalizeAgentRuntimeHost } from "../agent-runs/eve-adapter.ts";

const MAILBOX_ROUTE = "/eve/v1/internal/mailbox";
const DEFAULT_TIMEOUT_MS = 15_000;
const TRANSCRIPT_TIMEOUT_MS = 10 * 60_000;

export function createEveAgentMailboxRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImplementation: typeof fetch = fetch,
): AgentMailboxRuntime {
  const host = new URL(normalizeAgentRuntimeHost(environment.AGENT_RUNTIME_URL));
  const endpoint = new URL(MAILBOX_ROUTE, host).toString();
  const hostHeader = environment.AGENT_RUNTIME_HOST_HEADER?.trim();
  const secret = environment.AGENT_MAILBOX_DISPATCH_SECRET?.trim();
  const timeoutMs = readTimeout(environment.AGENT_RUNTIME_REQUEST_TIMEOUT_MS);

  const request = async (payload: Readonly<Record<string, unknown>>) => {
    const body = JSON.stringify(payload);
    const response = await fetchImplementation(endpoint, {
      body,
      headers: {
        "content-type": "application/json",
        ...(hostHeader ? { host: hostHeader } : {}),
        ...signMailboxDispatchBody(body, { secret }),
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { parsed, response } as const;
  };

  const transcript = async function* (input: { readonly sessionId: string; readonly startIndex: number }): AsyncIterable<MessageStreamEvent> {
    const body = JSON.stringify({ action: "transcript", sessionId: input.sessionId, startIndex: input.startIndex });
    const response = await fetchImplementation(endpoint, {
      body,
      headers: {
        "content-type": "application/json",
        ...(hostHeader ? { host: hostHeader } : {}),
        ...signMailboxDispatchBody(body, { secret }),
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(timeoutMs, TRANSCRIPT_TIMEOUT_MS)),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `Mailbox transcript request failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          yield parseTranscriptEvent(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) yield parseTranscriptEvent(buffer);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };

  return {
    readTranscript: transcript,
    async cancel(input) {
      const { parsed, response } = await request({
        action: "cancel",
        sessionId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      });
      if (
        !response.ok ||
        !isRecord(parsed) ||
        parsed.status !== "accepted" && parsed.status !== "no_active_turn"
      ) {
        throw new Error(problemMessage(parsed, `Mailbox cancellation failed with HTTP ${response.status}.`));
      }
      return parsed.status;
    },
    async inspect(input) {
      const { parsed, response } = await request({
        action: "inspect",
        sessionId: input.sessionId,
      });
      if (!response.ok || !isRecord(parsed)) {
        throw new Error(problemMessage(parsed, `Mailbox inspection failed with HTTP ${response.status}.`));
      }
      if (parsed.state === "running") {
        return {
          ...(validText(parsed.lastEventAt) ? { lastEventAt: parsed.lastEventAt } : {}),
          state: "running",
          ...(safeNonNegativeInteger(parsed.tailIndex) ? { tailIndex: parsed.tailIndex } : {}),
          ...(validText(parsed.turnId) ? { turnId: parsed.turnId } : {}),
        };
      }
      if (parsed.state === "terminal") {
        return {
          state: "terminal",
          ...(safeNonNegativeInteger(parsed.tailIndex) ? { tailIndex: parsed.tailIndex } : {}),
          ...(parsed.terminalStatus === "failed" || parsed.terminalStatus === "completed"
            ? { terminalStatus: parsed.terminalStatus }
            : {}),
        };
      }
      if (parsed.state === "waiting") {
        return {
          state: "waiting",
          ...(safeNonNegativeInteger(parsed.tailIndex) ? { tailIndex: parsed.tailIndex } : {}),
        };
      }
      throw new Error("The Agent runtime returned an invalid mailbox boundary.");
    },
    async reset(input) {
      const { parsed, response } = await request({
        action: "reset",
        sessionId: input.sessionId,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (
        !response.ok ||
        !isRecord(parsed) ||
        parsed.status !== "reset" && parsed.status !== "no_active_session"
      ) {
        throw new Error(problemMessage(parsed, `Mailbox reset failed with HTTP ${response.status}.`));
      }
      return parsed.status;
    },
    async deliver(input) {
      let result: Awaited<ReturnType<typeof request>>;
      try {
        result = await request({
          action: "deliver",
          ...(input.payload.operation?.beforeTurnId
            ? { beforeTurnId: input.payload.operation.beforeTurnId }
            : {}),
          clientMessageId: input.clientMessageId,
          ...(input.payload.clientContext ? { clientContext: input.payload.clientContext } : {}),
          itemId: input.itemId,
          ...(input.payload.operation?.expectedTurnId
            ? { expectedTurnId: input.payload.operation.expectedTurnId }
            : {}),
          ...(input.payload.operation?.kind ? { operationKind: input.payload.operation.kind } : {}),
          ...(input.payload.operation?.operationId
            ? { operationId: input.payload.operation.operationId }
            : {}),
          ...(input.payload.preferences ?? {}),
          ...(input.owner.issuer ? { issuer: input.owner.issuer } : {}),
          ...(input.payload.inputResponses
            ? { inputResponses: input.payload.inputResponses }
            : { message: input.payload.message }),
          principalId: input.owner.principalId,
          principalType: input.owner.principalType,
          sessionId: input.sessionId,
          tenantId: input.owner.tenantId,
        });
      } catch (error) {
        throw new AgentMailboxAdmissionError(
          "ambiguous",
          error instanceof Error ? error.message : "The mailbox admission transport failed.",
        );
      }
      const { parsed, response } = result;
      if (response.ok && isRecord(parsed) && validText(parsed.sessionId)) {
        return { sessionId: parsed.sessionId };
      }
      const message = problemMessage(parsed, `Mailbox admission failed with HTTP ${response.status}.`);
      if (response.status === 409 && isRecord(parsed) && parsed.code === "mailbox_turn_active") {
        throw new AgentMailboxAdmissionError("busy", message);
      }
      const rejected = [400, 401, 403, 404, 409, 410, 413].includes(response.status) &&
        isRecord(parsed) && parsed.code !== "mailbox_session_identity_changed";
      throw new AgentMailboxAdmissionError(rejected ? "rejected" : "ambiguous", message);
    },
  };
}

function parseTranscriptEvent(line: string): MessageStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("The Agent transcript bridge returned invalid JSON.");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("The Agent transcript bridge returned an invalid event.");
  }
  return value as unknown as MessageStreamEvent;
}

function readTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("AGENT_RUNTIME_REQUEST_TIMEOUT_MS must be an integer from 1000 to 120000.");
  }
  return parsed;
}

function problemMessage(value: unknown, fallback: string): string {
  return isRecord(value) && validText(value.error) ? value.error.slice(0, 2_000) : fallback;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
