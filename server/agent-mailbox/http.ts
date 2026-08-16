import type { AgentRuntimeConfigSnapshot } from "../../lib/agent-runtime-config.ts";
import { isBoundedAgentClientContext } from "@oworker/open-agent-contracts/client-context";
import {
  findAgentRuntimeModel,
  isAgentReasoningLevelForModel,
} from "../../lib/agent-runtime-config.ts";
import type { AgentMailboxItem } from "../data/agent-mailbox-store.ts";
import type {
  AgentSessionOwner,
  AgentSessionOwnershipStore,
} from "../data/session-ownership-store.ts";
import { enqueueAgentMailboxMessage } from "./service.ts";
import type { AgentMailboxStore } from "../data/agent-mailbox-store.ts";

const MAX_REQUEST_BYTES = 128 * 1024;

export async function enqueueAgentMailboxHttpRequest(options: {
  readonly owner: AgentSessionOwner;
  readonly ownershipStore?: AgentSessionOwnershipStore;
  readonly request: Request;
  readonly runtimeConfig: AgentRuntimeConfigSnapshot;
  readonly setCookie?: string;
  readonly store: AgentMailboxStore;
}): Promise<Response> {
  const contentLength = Number(options.request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return problem(413, "mailbox_request_too_large", "The mailbox request exceeds 128 KiB.", options.setCookie);
  }
  let value: unknown;
  try {
    value = await options.request.json();
  } catch {
    return problem(400, "invalid_json", "The mailbox request must be valid JSON.", options.setCookie);
  }
  const parsed = parseEnqueueRequest(value, options.runtimeConfig);
  if (!parsed.ok) {
    return problem(400, "mailbox_request_invalid", parsed.error, options.setCookie);
  }

  try {
    let result = await enqueueAgentMailboxMessage({
      ...parsed.value,
      owner: options.owner,
      store: options.store,
    });
    if (result.status === "missing-session" && options.ownershipStore) {
      const ownership = await options.ownershipStore.waitForOwnership(
        parsed.value.sessionId,
        options.owner,
      );
      if (ownership === "owned") {
        result = await enqueueAgentMailboxMessage({
          ...parsed.value,
          owner: options.owner,
          store: options.store,
        });
      } else if (ownership === "forbidden") {
        result = { status: "forbidden" };
      }
    }
    if (result.status === "missing-session") {
      return problem(404, "mailbox_session_not_found", "The Agent session was not found.", options.setCookie);
    }
    if (result.status === "forbidden") {
      return problem(403, "mailbox_session_forbidden", "This principal does not own the Agent session.", options.setCookie);
    }
    if (result.status === "full") {
      return problem(429, "mailbox_full", "This Agent session already has five pending messages.", options.setCookie);
    }
    if (result.status === "conflict") {
      return problem(409, "mailbox_idempotency_conflict", "This client message id was used for another payload.", options.setCookie);
    }
    if (!("item" in result)) {
      return problem(500, "mailbox_state_invalid", "The mailbox returned an invalid state.", options.setCookie);
    }
    return mailboxResponse(result.item, result.status, options.setCookie);
  } catch (error) {
    return problem(
      400,
      "mailbox_request_invalid",
      error instanceof Error ? error.message : "The mailbox request is invalid.",
      options.setCookie,
    );
  }
}

function parseEnqueueRequest(
  value: unknown,
  config: AgentRuntimeConfigSnapshot,
): { readonly ok: false; readonly error: string } | {
  readonly ok: true;
  readonly value: Parameters<typeof enqueueAgentMailboxMessage>[0] extends infer T
    ? Omit<T, "owner" | "store">
    : never;
} {
  if (!isRecord(value)) return { error: "The mailbox request must be an object.", ok: false };
  if (!validText(value.clientMessageId) || !validText(value.message) || !validText(value.sessionId)) {
    return { error: "clientMessageId, message, and sessionId are required.", ok: false };
  }
  if (!isRecord(value.preferences)) {
    return { error: "A validated Agent preference snapshot is required.", ok: false };
  }
  const clientContext = parseClientContext(value.clientContext);
  if (value.clientContext !== undefined && !clientContext) {
    return { error: "The mailbox client context is invalid.", ok: false };
  }
  const operationKind = value.operationKind;
  if (value.operationId !== undefined && !validText(value.operationId)) {
    return { error: "operationId must be a non-empty string.", ok: false };
  }
  if (value.expectedTurnId !== undefined && !validText(value.expectedTurnId)) {
    return { error: "expectedTurnId must be a non-empty string.", ok: false };
  }
  if (operationKind !== undefined && operationKind !== "send" && operationKind !== "steer" && operationKind !== "edit") {
    return { error: "operationKind must be send, steer, or edit.", ok: false };
  }
  if (value.operationId !== undefined && operationKind === undefined) {
    return { error: "operationKind is required when operationId is provided.", ok: false };
  }
  if (operationKind === "steer" && !validText(value.expectedTurnId)) {
    return { error: "expectedTurnId is required for a steering operation.", ok: false };
  }
  const modelId = value.preferences.modelId;
  const reasoning = value.preferences.reasoning;
  const executionMode = value.preferences.executionMode;
  if (
    !validText(modelId) ||
    !validText(reasoning) ||
    executionMode !== "automation" && executionMode !== "cautious" && executionMode !== "standard"
  ) return { error: "The Agent preference snapshot is invalid.", ok: false };
  const model = findAgentRuntimeModel(config, modelId);
  if (!model || !isAgentReasoningLevelForModel(model, reasoning)) {
    return { error: "The selected Agent model or reasoning level is not published.", ok: false };
  }
  return {
    ok: true,
    value: {
      clientMessageId: value.clientMessageId,
      ...(clientContext ? { clientContext } : {}),
      ...(validText(value.operationId) ? { operationId: value.operationId } : {}),
      ...(validText(value.expectedTurnId) ? { expectedTurnId: value.expectedTurnId } : {}),
      ...(operationKind
        ? { operationKind }
        : {}),
      message: value.message,
      preferences: { executionMode, modelId, reasoning },
      sessionId: value.sessionId,
    },
  };
}

function parseClientContext(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return isBoundedAgentClientContext(value) ? value : undefined;
}

function mailboxResponse(
  item: AgentMailboxItem,
  disposition: "created" | "replay",
  setCookie?: string,
): Response {
  return Response.json(
    {
      disposition,
      item: {
        clientMessageId: item.clientMessageId,
        itemId: item.itemId,
        ...(item.payload.operation?.expectedTurnId
          ? { expectedTurnId: item.payload.operation.expectedTurnId }
          : {}),
        ...(item.payload.operation?.kind ? { operationKind: item.payload.operation.kind } : {}),
        ...(item.payload.operation?.operationId
          ? { operationId: item.payload.operation.operationId }
          : {}),
        status: item.status,
      },
      ok: true,
    },
    {
      headers: {
        "cache-control": "no-store",
        ...(setCookie ? { "set-cookie": setCookie } : {}),
      },
      status: disposition === "created" ? 202 : 200,
    },
  );
}

function problem(status: number, code: string, error: string, setCookie?: string): Response {
  return Response.json(
    { code, error, ok: false },
    {
      headers: {
        "cache-control": "no-store",
        ...(setCookie ? { "set-cookie": setCookie } : {}),
      },
      status,
    },
  );
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
