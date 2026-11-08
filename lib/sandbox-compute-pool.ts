import type { SandboxConnection } from "eve/sandbox/provider";

export type SandboxAdmissionStats = { readonly activeSessions: number; readonly limit: number; readonly queuedSessions: number };
let latestStats: SandboxAdmissionStats | undefined;
export function getSandboxAdmissionStats() { return latestStats; }

export class SandboxAdmissionError extends Error {
  readonly code = "SANDBOX_CAPACITY_TIMEOUT";
  constructor(timeoutMs: number) { super(`Sandbox capacity was not available within ${timeoutMs}ms.`); this.name = "SandboxAdmissionError"; }
}
export class SandboxAdmissionQueueFullError extends Error {
  readonly code = "SANDBOX_CAPACITY_QUEUE_FULL";
  constructor(maxQueued: number) { super(`Sandbox admission queue is full (${maxQueued} waiting sessions).`); this.name = "SandboxAdmissionQueueFullError"; }
}
type Waiter = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Entry = {
  readonly admitted: Promise<void>;
  readonly stop: () => Promise<void>;
  references: number;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
};

/** Compute is session-scoped; Eve connections are step-scoped. */
export function createSandboxComputePool(options: {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly timeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly onIdleError?: (error: unknown, sessionId: string) => void;
}) {
  for (const [key, value] of Object.entries(options)) {
    if (key !== "onIdleError" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) throw new Error(`Invalid sandbox pool ${key}.`);
  }
  const entries = new Map<string, Entry>();
  const waiters: Waiter[] = [];
  // A session may be resumed while its idle stop or deletion is in flight.
  // Serialize only lifecycle changes, never command execution across sessions.
  const operations = new Map<string, Promise<unknown>>();
  function exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = operations.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    operations.set(id, result);
    void result.finally(() => {
      if (operations.get(id) === result) operations.delete(id);
    }).catch(() => undefined);
    return result;
  }
  let active = 0;
  const publish = () => { latestStats = { activeSessions: active, limit: options.maxActive, queuedSessions: waiters.length }; };
  publish();
  function acquire(): Promise<void> {
    if (active < options.maxActive) { active++; publish(); return Promise.resolve(); }
    if (waiters.length >= options.maxQueued) return Promise.reject(new SandboxAdmissionQueueFullError(options.maxQueued));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        publish(); reject(new SandboxAdmissionError(options.timeoutMs));
      }, options.timeoutMs) };
      waiter.timer.unref?.(); waiters.push(waiter); publish();
    });
  }
  function release(id: string, entry: Entry) {
    if (entries.get(id) !== entry) return;
    entries.delete(id); active--;
    const waiter = waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); active++; waiter.resolve(); }
    publish();
  }
  function stop(id: string, entry: Entry): Promise<void> {
    return exclusive(id, async () => {
      if (entries.get(id) !== entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      const operation = entry.admitted.then(entry.stop);
      entry.stopping = operation;
      try {
        await operation;
        release(id, entry);
      } finally {
        entry.stopping = undefined;
      }
    });
  }
  function idle(id: string, entry: Entry) {
    if (entries.get(id) !== entry || entry.references !== 0 || entry.stopping) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      // A resume queued before this callback must get to cancel the idle stop.
      void exclusive(id, async () => {
        if (entries.get(id) !== entry || entry.references !== 0) return;
        const operation = entry.admitted.then(entry.stop);
        entry.stopping = operation;
        try { await operation; release(id, entry); }
        finally { entry.stopping = undefined; }
      }).catch((error) => options.onIdleError?.(error, id));
    }, options.idleTimeoutMs);
    entry.timer.unref?.();
  }
  function open<E extends object>(id: string, connect: () => Promise<SandboxConnection<E>>, stopCompute: () => Promise<void>): Promise<SandboxConnection<E>> {
    return exclusive(id, async () => {
      let entry = entries.get(id);
      if (!entry) {
        entry = { admitted: acquire(), references: 0, stop: stopCompute };
        entries.set(id, entry);
      }
      const current = entry;
      try { await current.admitted; }
      catch (error) { if (entries.get(id) === current) entries.delete(id); throw error; }
      if (current.timer) clearTimeout(current.timer);
      let connection: SandboxConnection<E>;
      try { connection = await connect(); }
      catch (error) {
        if (current.references === 0) {
          try { await current.stop(); release(id, current); }
          catch { idle(id, current); }
        }
        throw error;
      }
      current.references++;
      let closed = false;
      let closing: Promise<void> | undefined;
      const assertOpen = () => {
        if (closed || closing || current.stopping || entries.get(id) !== current) {
          throw new Error("This sandbox connection is closed; resume it through Eve in the next step.");
        }
      };
      return {
        ...connection,
        spawn(input) { assertOpen(); return connection.spawn(input); },
        readFile(input) { assertOpen(); return connection.readFile(input); },
        writeFiles(input) { assertOpen(); return connection.writeFiles(input); },
        removePath(input) { assertOpen(); return connection.removePath(input); },
        stop: () => stop(id, current),
        close() {
          if (closed) return Promise.resolve();
          if (closing) return closing;
          closing = exclusive(id, async () => {
            await connection.close?.();
            closed = true;
            current.references--;
            idle(id, current);
          }).finally(() => { closing = undefined; });
          return closing;
        },
      };
    });
  }
  return {
    open,
    destroy(id: string, remove: () => Promise<void>) {
      return exclusive(id, async () => {
        const entry = entries.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        if (entry) await entry.admitted;
        const operation = remove();
        if (entry) entry.stopping = operation;
        try { await operation; if (entry) release(id, entry); }
        finally { if (entry) { entry.stopping = undefined; idle(id, entry); } }
      });
    },
  };
}
