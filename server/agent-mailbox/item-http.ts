import type { AgentMailboxItem, AgentMailboxStore } from "../data/agent-mailbox-store.ts";
import type { AgentSessionOwner } from "../data/session-ownership-store.ts";

export async function inspectAgentMailboxItemHttp(options: {
  readonly itemId: string;
  readonly owner: AgentSessionOwner;
  readonly setCookie?: string;
  readonly store: AgentMailboxStore;
}): Promise<Response> {
  const item = await options.store.findOwned(options.owner, options.itemId);
  return item
    ? itemResponse(item, options.setCookie)
    : problem(404, "mailbox_item_not_found", "The mailbox item was not found.", options.setCookie);
}

export async function cancelAgentMailboxItemHttp(options: {
  readonly itemId: string;
  readonly owner: AgentSessionOwner;
  readonly setCookie?: string;
  readonly store: AgentMailboxStore;
}): Promise<Response> {
  const item = await options.store.cancelOwned(options.owner, options.itemId);
  if (item) return itemResponse(item, options.setCookie);
  const existing = await options.store.findOwned(options.owner, options.itemId);
  return existing
    ? problem(409, "mailbox_item_not_cancellable", "This mailbox item can no longer be cancelled.", options.setCookie)
    : problem(404, "mailbox_item_not_found", "The mailbox item was not found.", options.setCookie);
}

export async function retryAgentMailboxItemHttp(options: {
  readonly itemId: string;
  readonly owner: AgentSessionOwner;
  readonly setCookie?: string;
  readonly store: AgentMailboxStore;
}): Promise<Response> {
  const item = await options.store.retryOwned(options.owner, options.itemId);
  if (item) return itemResponse(item, options.setCookie);
  const existing = await options.store.findOwned(options.owner, options.itemId);
  return existing
    ? problem(409, "mailbox_item_not_retryable", "Only a rejected mailbox delivery can be retried.", options.setCookie)
    : problem(404, "mailbox_item_not_found", "The mailbox item was not found.", options.setCookie);
}

function itemResponse(item: AgentMailboxItem, setCookie?: string): Response {
  return Response.json(
    {
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
        ...(item.lastError ? { lastError: item.lastError } : {}),
        status: item.status,
      },
      ok: true,
    },
    { headers: responseHeaders(setCookie) },
  );
}

function problem(status: number, code: string, error: string, setCookie?: string): Response {
  return Response.json(
    { code, error, ok: false },
    { headers: responseHeaders(setCookie), status },
  );
}

function responseHeaders(setCookie?: string): HeadersInit {
  return {
    "cache-control": "no-store",
    ...(setCookie ? { "set-cookie": setCookie } : {}),
  };
}
