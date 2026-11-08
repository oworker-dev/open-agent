import type { RouteHandlerArgs } from "eve/channels";
type Session = ReturnType<RouteHandlerArgs["attachSession"]>;
import type { SessionAuthContext } from "eve/context";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { conversation } from "eve/events";
import type { AgentMailboxEditPlan, AgentMailboxStore } from "../../server/data/agent-mailbox-store.ts";
import type { AgentSessionOwner } from "../../server/data/session-ownership-store.ts";
import { eveEventsCursor } from "../../lib/eve-stream.ts";

export class MailboxEditPendingError extends Error {
  constructor() { super("The edit is waiting for its recorded context-clear receipt; it is safe to retry this mailbox item."); }
}
export class MailboxEditRejectedError extends Error {}
const clearPrincipal = (itemId: string) => `mailbox-edit-clear:${itemId}`;

async function readTranscript(session: Session, startIndex = 0): Promise<SessionStreamEvent[]> {
  const events: SessionStreamEvent[] = [];
  for await (const event of session.stream({ startIndex, follow: false, signal: AbortSignal.timeout(10_000) })) events.push(event);
  if (events.at(-1)?.meta.endOfLine === false) throw new MailboxEditPendingError();
  return events;
}

/** Construct an immutable edit plan from the selected branch, never timestamps. */
export function planMailboxEdit(events: readonly SessionStreamEvent[], beforeTurnId: string): AgentMailboxEditPlan {
  const state = conversationOf(events);
  const turns = conversation(state.view);
  if (!turns.some((turn) => turn.turnId === beforeTurnId)) throw new MailboxEditRejectedError("The edit target is no longer on the selected conversation branch.");
  const consumed = events.filter((event) => event.type === "delivery.consumed" && event.data.turnId === beforeTurnId && event.data.parts.length > 0);
  if (consumed.length !== 1) throw new MailboxEditRejectedError("Only a turn with one user message can be edited.");
  const selected = new Set(turns.map((turn) => turn.turnId));
  const imported = new Set(events.flatMap((event) => event.type === "delivery.consumed" && selected.has(event.data.turnId)
    ? (event.data.history ?? []).map((_message, index) => `${event.data.deliveryId}:imported:${index}`) : []));
  const visible = state.messages.filter((message) => imported.has(message.id) || !!message.metadata?.turnId && selected.has(message.metadata.turnId));
  const targetIndex = visible.findIndex((message) => message.role === "user" && !imported.has(message.id) && message.metadata?.turnId === beforeTurnId);
  if (targetIndex < 0) throw new MailboxEditRejectedError("The edit target has no authoritative user message.");
  const originals = new Map(state.messages.map((message) => [message.id, message]));
  const history = visible.slice(0, targetIndex).map((message) => {
    // Keep original app ids across repeated edits, so rich UI rows join once.
    let id = message.id;
    let original = message;
    const visited = new Set<string>();
    while (original.metadata?.historyId && !visited.has(original.id)) {
      visited.add(original.id); id = original.metadata.historyId;
      const next = originals.get(id); if (!next) break; original = next;
    }
    const text = message.parts.flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "file") return [`[Attachment: ${part.filename ?? part.mediaType}${part.url ? ` (${part.url})` : ""}]`];
      if (part.type === "tool") return [`[Tool ${part.name}: ${JSON.stringify(part)}]`];
      return [];
    }).join("\n");
    return { id, role: message.role, text: text || `[${message.role} message]` };
  });
  return { history, phase: "prepared", startIndex: eveEventsCursor(events) };
}

/** Match the clear we issued as a named service actor, even after a lost HTTP receipt. */
export function observeEditClear(events: readonly SessionStreamEvent[], itemId: string, recordedId?: string): "completed" | "failed" | "pending" {
  const ids = new Set(events.flatMap((event) => event.type === "delivery.admitted" &&
    event.data.principal?.type === "service" && event.data.principal.id === clearPrincipal(itemId) &&
    event.data.source && "control" in event.data.source && event.data.source.control === "clear" ? [event.data.deliveryId] : []));
  if (recordedId) ids.add(recordedId);
  const changes = new Set(events.flatMap((event) => event.type === "context.started" && event.data.kind === "clear" &&
    event.data.cause && "deliveryId" in event.data.cause && ids.has(event.data.cause.deliveryId) ? [event.data.changeId] : []));
  const settled = events.findLast((event) => event.type === "context.settled" && changes.has(event.data.changeId));
  if (settled?.type === "context.settled") return settled.data.outcome === "completed" && settled.data.selects === null ? "completed" : "failed";
  return "pending";
}

export async function prepareMailboxEditTransaction(options: {
  readonly auth: SessionAuthContext;
  readonly beforeTurnId: string;
  readonly itemId: string;
  readonly owner: AgentSessionOwner;
  readonly session: Session;
  readonly store: AgentMailboxStore;
}): Promise<AgentMailboxEditPlan> {
  const { store, itemId, session } = options;
  let item = await store.findOwned(options.owner, itemId);
  if (!item || item.sessionId !== session.id || item.payload.operation?.beforeTurnId !== options.beforeTurnId) throw new MailboxEditRejectedError("The mailbox edit does not match its stored target.");
  if (item.status === "cancelled" || item.status === "failed") throw new MailboxEditRejectedError("The mailbox edit has already been withdrawn.");
  if (!item.editPlan) item = await store.prepareEdit(itemId, planMailboxEdit(await readTranscript(session), options.beforeTurnId));
  let plan = item.editPlan!;
  if (plan.phase === "cleared") return plan;
  if (await store.claimEditClear(itemId)) {
    // This is an internal service action on behalf of the verified owner. Its
    // audit principal identifies the operation without changing the send actor.
    const receipt = await session.clear({ auth: {
      ...options.auth, authenticator: "agent-mailbox-edit-clear", principalId: clearPrincipal(itemId), principalType: "service",
    } });
    await store.recordEditClear(itemId, receipt.deliveryId);
    plan = { ...plan, clearDeliveryId: receipt.deliveryId };
    try { await receipt.result({ signal: AbortSignal.timeout(5_000) }); }
    catch { /* Recover the committed clear from the authoritative log below. */ }
  }
  const current = await store.findOwned(options.owner, itemId);
  plan = current?.editPlan ?? plan;
  if (plan.phase === "cleared") return plan;
  const outcome = observeEditClear(await readTranscript(session, plan.startIndex), itemId, plan.clearDeliveryId);
  if (outcome === "failed") throw new MailboxEditRejectedError("The runtime refused the edit's context clear; no replacement was submitted.");
  if (outcome !== "completed") throw new MailboxEditPendingError();
  await store.completeEditClear(itemId);
  return { ...plan, phase: "cleared" };
}
