import type { SandboxBackend, SandboxBackendHandle } from "eve/sandbox";

type IdleTimer = ReturnType<typeof setTimeout>;
const SANDBOX_HANDLE_IDENTITY = Symbol.for("eve.sandbox.handle-identity.v1");
const SANDBOX_SHUTDOWN_LISTENER = Symbol.for("eve.sandbox.shutdown-listener.v1");

type LifecycleAwareSandboxHandle<SO> = SandboxBackendHandle<SO> & {
  readonly [SANDBOX_HANDLE_IDENTITY]: object;
  readonly [SANDBOX_SHUTDOWN_LISTENER]: (listener: () => void) => () => void;
};

type IdleEntry<SO> = {
  generation: number;
  handle: SandboxBackendHandle<SO>;
  readonly identity: object;
  readonly shutdownListeners: Set<() => void>;
  operation?: Promise<void>;
  timer?: IdleTimer;
};

export type IdleSandboxScheduler = {
  clear(timer: IdleTimer): void;
  schedule(callback: () => void, delayMs: number): IdleTimer;
};

const defaultScheduler: IdleSandboxScheduler = {
  clear(timer) {
    clearTimeout(timer);
  },
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
};

/**
 * Stop idle backend compute after Eve has captured a durable sandbox state.
 * The backend-owned session state remains intact and its next create call can
 * reattach it. A per-session handoff prevents a new create racing an in-flight
 * idle shutdown.
 */
export function withIdleSandboxShutdown<BO, SO>(
  backend: SandboxBackend<BO, SO>,
  idleTimeoutMs: number,
  options: {
    readonly onIdleShutdownError?: (error: unknown, sessionKey: string) => void;
    readonly scheduler?: IdleSandboxScheduler;
  } = {},
): SandboxBackend<BO, SO> {
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error("idleTimeoutMs must be a positive integer.");
  }
  const entries = new Map<string, IdleEntry<SO>>();
  const creations = new Map<string, Promise<IdleEntry<SO>>>();
  const scheduler = options.scheduler ?? defaultScheduler;
  let nextGeneration = 0;

  return {
    ...backend,
    async create(input) {
      const previous = entries.get(input.sessionKey);
      if (previous?.timer) {
        scheduler.clear(previous.timer);
        previous.timer = undefined;
      }
      if (previous?.operation) {
        try {
          await previous.operation;
        } catch {
          // Failed shutdown means the previous compute may still be live.
          // Reattach to it so admission remains balanced and shutdown can be
          // retried through the returned handle.
          return wrapHandle(previous, input.sessionKey);
        }
      } else if (previous) {
        // A durable step can reattach before the idle timer fires. Reuse the
        // live backend handle instead of creating a second lease for the same
        // compute. This also keeps session-scoped admission permits balanced.
        return wrapHandle(previous, input.sessionKey);
      }

      let creation = creations.get(input.sessionKey);
      if (!creation) {
        creation = backend.create(input).then((handle) => {
          const entry: IdleEntry<SO> = {
            generation: ++nextGeneration,
            handle,
            identity: {},
            shutdownListeners: new Set(),
          };
          entries.set(input.sessionKey, entry);
          return entry;
        });
        creations.set(input.sessionKey, creation);
        void creation.finally(() => {
          if (creations.get(input.sessionKey) === creation) creations.delete(input.sessionKey);
        }).catch(() => undefined);
      }
      const entry = await creation;
      return wrapHandle(entry, input.sessionKey);
    },
  };

  function wrapHandle(
    entry: IdleEntry<SO>,
    sessionKey: string,
  ): LifecycleAwareSandboxHandle<SO> {
    const stop = (): Promise<void> => {
      if (entry.operation) return entry.operation;
      const current = entries.get(sessionKey);
      if (current === entry && entry.timer) {
        scheduler.clear(entry.timer);
        entry.timer = undefined;
      }
      const operation = entry.handle.shutdown();
      entry.operation = operation;
      void operation.then(
        () => {
          if (entries.get(sessionKey) === entry) entries.delete(sessionKey);
          for (const listener of entry.shutdownListeners) listener();
          entry.shutdownListeners.clear();
        },
        () => {
          if (entry.operation === operation) entry.operation = undefined;
        },
      );
      return operation;
    };

    const handle: LifecycleAwareSandboxHandle<SO> = {
      ...entry.handle,
      [SANDBOX_HANDLE_IDENTITY]: entry.identity,
      [SANDBOX_SHUTDOWN_LISTENER](listener: () => void) {
        entry.shutdownListeners.add(listener);
        return () => entry.shutdownListeners.delete(listener);
      },
      async captureState() {
        const state = await entry.handle.captureState();
        if (entry.operation || entries.get(sessionKey) !== entry) return state;
        if (entry.timer) scheduler.clear(entry.timer);
        entry.timer = scheduler.schedule(() => {
          const current = entries.get(sessionKey);
          if (current !== entry) return;
          current.timer = undefined;
          void stop().catch((error) => options.onIdleShutdownError?.(error, sessionKey));
        }, idleTimeoutMs);
        return state;
      },
      shutdown: stop,
    };
    return handle;
  }
}
