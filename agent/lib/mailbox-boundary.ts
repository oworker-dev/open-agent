import type { SessionReader } from "eve/sessions";
import type { SessionStreamEvent } from "eve/client";
import {
  activeTurn, emptySessionView, foldEvents, idle, position, session as observeSession,
  type SessionView,
} from "eve/events";

const DEFAULT_INSPECTION_TIMEOUT_MS = 10_000;
const MAX_CACHED_SESSIONS = 32;
const snapshots = new Map<string, SessionView>();

export type MailboxBoundary =
  | { readonly lastEventAt?: string; readonly state: "running"; readonly tailIndex?: number; readonly turnId?: string }
  | { readonly state: "waiting"; readonly tailIndex?: number }
  | { readonly state: "terminal"; readonly tailIndex?: number; readonly terminalStatus?: "completed" | "failed" };

export class MailboxBoundaryInspectionTimeoutError extends Error {
  constructor() {
    super("The Agent runtime did not expose a mailbox boundary in time.");
    this.name = "MailboxBoundaryInspectionTimeoutError";
  }
}

/** Fold complete durable commits, never guess readiness from the last fact. */
export async function inspectMailboxBoundary(
  reader: SessionReader,
  timeoutMs = DEFAULT_INSPECTION_TIMEOUT_MS,
): Promise<MailboxBoundary> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Mailbox inspection timeout must be a positive finite number.");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new MailboxBoundaryInspectionTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  let view = snapshots.get(reader.id) ?? emptySessionView();
  let lastEventAt: string | undefined;
  const iterator = reader.stream({ startIndex: position(view), follow: false, signal: controller.signal })[Symbol.asyncIterator]();
  try {
    await Promise.race([deadline, (async () => {
      let batch: SessionStreamEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        batch.push(next.value);
        lastEventAt = next.value.meta.at;
        if (batch.length >= 128 && next.value.meta.endOfLine !== false) {
          view = foldEvents(view, batch);
          batch = [];
        }
      }
      if (batch.at(-1)?.meta.endOfLine === false) throw new Error("The mailbox transcript ended inside a commit.");
      if (batch.length) view = foldEvents(view, batch);
    })()]);
    controller.signal.throwIfAborted();
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    // A broken reader may ignore abort. Do not let its pending next()/return()
    // keep the HTTP request open beyond the inspection deadline.
    if (controller.signal.aborted) void iterator.return?.().catch(() => undefined);
  }
  // A failed/partial read is never published. Concurrent inspections cannot
  // replace a newer cached snapshot with an older one.
  if (position(view) >= position(snapshots.get(reader.id) ?? emptySessionView())) {
    snapshots.delete(reader.id);
    snapshots.set(reader.id, view);
    if (snapshots.size > MAX_CACHED_SESSIONS) snapshots.delete(snapshots.keys().next().value!);
  }
  const observed = observeSession(view);
  if (observed.status === "new") throw new Error("The Agent session has no recorded history.");
  const tailIndex = position(view) - 1;
  if (observed.status === "ended") return {
    state: "terminal", tailIndex,
    terminalStatus: observed.outcome === "failed" ? "failed" : "completed",
  };
  const turn = activeTurn(view);
  if (turn || !idle(view)) return {
    state: "running", tailIndex,
    ...(turn ? { turnId: turn.turnId } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
  };
  return { state: "waiting", tailIndex };
}
