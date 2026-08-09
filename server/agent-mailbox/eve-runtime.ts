import type { AgentMailboxRuntime } from "./service.ts";
import { AgentMailboxAdmissionError } from "./service.ts";
import { signMailboxDispatchBody } from "../../agent/lib/mailbox-dispatch-auth.ts";
import { normalizeAgentRuntimeHost } from "../agent-runs/eve-adapter.ts";

const MAILBOX_ROUTE = "/eve/v1/internal/mailbox";
const DEFAULT_TIMEOUT_MS = 15_000;

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

  return {
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
          state: "running",
          ...(validText(parsed.turnId) ? { turnId: parsed.turnId } : {}),
        };
      }
      if (parsed.state === "terminal") {
        return { state: "terminal" };
      }
      if (parsed.state === "waiting") {
        return { state: "waiting" };
      }
      throw new Error("The Agent runtime returned an invalid mailbox boundary.");
    },
    async deliver(input) {
      let result: Awaited<ReturnType<typeof request>>;
      try {
        result = await request({
          action: "deliver",
          clientMessageId: input.clientMessageId,
          ...(input.payload.clientContext ? { clientContext: input.payload.clientContext } : {}),
          itemId: input.itemId,
          ...(input.payload.preferences ?? {}),
          ...(input.owner.issuer ? { issuer: input.owner.issuer } : {}),
          message: input.payload.message,
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
      const rejected = [400, 401, 403, 404, 409, 410, 413].includes(response.status) &&
        isRecord(parsed) && parsed.code !== "mailbox_session_identity_changed";
      throw new AgentMailboxAdmissionError(rejected ? "rejected" : "ambiguous", message);
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
