import type { SandboxBackend, SandboxBackendHandle } from "eve/sandbox";

type IdleTimer = ReturnType<typeof setTimeout>;

type IdleEntry = {
  generation: number;
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
  const entries = new Map<string, IdleEntry>();
  const scheduler = options.scheduler ?? defaultScheduler;
  let nextGeneration = 0;

  return {
    ...backend,
    async create(input) {
      const previous = entries.get(input.sessionKey);
      if (previous?.timer) scheduler.clear(previous.timer);
      if (previous?.operation) {
        await previous.operation.catch(() => undefined);
      }

      const handle = await backend.create(input);
      const generation = ++nextGeneration;
      entries.set(input.sessionKey, { generation });
      return wrapHandle(handle, input.sessionKey, generation);
    },
  };

  function wrapHandle(
    handle: SandboxBackendHandle<SO>,
    sessionKey: string,
    generation: number,
  ): SandboxBackendHandle<SO> {
    let shutdown: Promise<void> | undefined;

    const stop = (): Promise<void> => {
      if (shutdown) return shutdown;
      const entry = entries.get(sessionKey);
      if (entry?.generation === generation && entry.timer) {
        scheduler.clear(entry.timer);
        entry.timer = undefined;
      }
      shutdown = handle.shutdown();
      if (entry?.generation === generation) entry.operation = shutdown;
      void shutdown.finally(() => {
        if (entries.get(sessionKey)?.generation === generation) entries.delete(sessionKey);
      }).catch(() => undefined);
      return shutdown;
    };

    return {
      ...handle,
      async captureState() {
        const state = await handle.captureState();
        if (shutdown) return state;
        const entry = entries.get(sessionKey);
        if (entry?.generation !== generation) return state;
        if (entry.timer) scheduler.clear(entry.timer);
        entry.timer = scheduler.schedule(() => {
          const current = entries.get(sessionKey);
          if (current?.generation !== generation) return;
          current.timer = undefined;
          void stop().catch((error) => options.onIdleShutdownError?.(error, sessionKey));
        }, idleTimeoutMs);
        return state;
      },
      shutdown: stop,
    };
  }
}
