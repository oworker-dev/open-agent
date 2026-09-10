import type { Session } from "eve/channels";
import type { MessageStreamEvent } from "eve/client";

const DEFAULT_INSPECTION_TIMEOUT_MS = 10_000;

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

export async function inspectMailboxBoundary(
  session: Pick<Session, "getEventStream" | "getStreamTailIndex">,
  timeoutMs = DEFAULT_INSPECTION_TIMEOUT_MS,
): Promise<MailboxBoundary> {
  const deadline = createInspectionDeadline(timeoutMs);
  let reader: ReadableStreamDefaultReader<MessageStreamEvent> | undefined;
  try {
    const tailIndex = await deadline.wait(session.getStreamTailIndex());
    // Resolve the tail to an absolute cursor before reading it. Tail-relative
    // streams are live-following in Eve and can remain open indefinitely.
    if (tailIndex < 0) return { state: "running", tailIndex };
    const stream = await deadline.wait(session.getEventStream({ startIndex: tailIndex }));
    reader = stream.getReader();
    const latest = await deadline.wait(reader.read(), () => reader?.cancel());
    if (latest.done || !latest.value) return { state: "running", tailIndex };
    if (latest.value.type === "session.waiting") {
      return { state: "waiting", tailIndex };
    }
    if (latest.value.type === "session.completed") {
      return { state: "terminal", tailIndex, terminalStatus: "completed" };
    }
    if (latest.value.type === "session.failed") {
      return { state: "terminal", tailIndex, terminalStatus: "failed" };
    }
    const data: unknown = latest.value.data;
    const record = isRecord(data) ? data : undefined;
    const turnId = record && validText(record["turnId"], 512)
      ? record["turnId"]
      : undefined;
    const at = latest.value.meta?.at;
    return {
      state: "running",
      ...(typeof at === "string" ? { lastEventAt: at } : {}),
      tailIndex,
      ...(turnId ? { turnId } : {}),
    };
  } finally {
    deadline.dispose();
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

function createInspectionDeadline(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Mailbox inspection timeout must be a positive finite number.");
  }
  const startedAt = Date.now();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  return {
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    async wait<T>(promise: Promise<T>, onTimeout?: () => void | Promise<void>): Promise<T> {
      const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
      if (remaining === 0) {
        await onTimeout?.();
        throw new MailboxBoundaryInspectionTimeoutError();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (timer) timers.delete(timer);
          // Reject first. Cancelling a pending stream reader may resolve its
          // read with `{ done: true }`; doing that before rejection would make
          // a half-open tail look like a valid empty transcript.
          reject(new MailboxBoundaryInspectionTimeoutError());
          void Promise.resolve(onTimeout?.()).catch(() => undefined);
        }, remaining);
        timers.add(timer);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) {
          clearTimeout(timer);
          timers.delete(timer);
        }
      }
    },
  };
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
