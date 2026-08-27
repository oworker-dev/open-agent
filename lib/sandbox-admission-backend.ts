import type { SandboxBackend, SandboxBackendHandle } from "eve/sandbox";

export type SandboxAdmissionStats = {
  readonly activeSessions: number;
  readonly limit: number;
  readonly queuedSessions: number;
};

export class SandboxAdmissionError extends Error {
  readonly code = "SANDBOX_CAPACITY_TIMEOUT";

  constructor(timeoutMs: number) {
    super(`Sandbox capacity was not available within ${timeoutMs}ms.`);
    this.name = "SandboxAdmissionError";
  }
}

type Waiter = {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type ActiveSession = {
  admitted: boolean;
  readonly admission: Promise<void>;
  references: number;
};

/**
 * Bound live sandbox compute independently from durable-session count. A
 * session reattach keeps its existing permit; a different session waits in
 * FIFO order and fails before backend allocation when the host is saturated.
 */
export function withSandboxAdmission<BO, SO>(
  backend: SandboxBackend<BO, SO>,
  limit: number,
  timeoutMs: number,
  options: {
    readonly onStats?: (stats: SandboxAdmissionStats) => void;
  } = {},
): SandboxBackend<BO, SO> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("sandbox admission limit must be a positive integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("sandbox admission timeoutMs must be a positive integer.");
  }

  const active = new Map<string, ActiveSession>();
  const waiters: Waiter[] = [];
  let permitsInUse = 0;

  return {
    ...backend,
    async create(input) {
      let session = active.get(input.sessionKey);
      if (!session) {
        session = {
          admitted: false,
          admission: acquire(),
          references: 0,
        };
        active.set(input.sessionKey, session);
      }

      try {
        await session.admission;
        session.admitted = true;
      } catch (error) {
        if (active.get(input.sessionKey) === session) active.delete(input.sessionKey);
        publishStats();
        throw error;
      }

      session.references += 1;
      publishStats();
      try {
        const handle = await backend.create(input);
        return wrapHandle(handle, input.sessionKey, session);
      } catch (error) {
        release(input.sessionKey, session);
        throw error;
      }
    },
  };

  async function acquire(): Promise<void> {
    if (permitsInUse < limit && waiters.length === 0) {
      permitsInUse += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        reject,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          publishStats();
          reject(new SandboxAdmissionError(timeoutMs));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      waiters.push(waiter);
      publishStats();
    });
  }

  function release(sessionKey: string, session: ActiveSession): void {
    if (active.get(sessionKey) !== session || session.references === 0) return;
    session.references -= 1;
    if (session.references > 0) {
      publishStats();
      return;
    }
    active.delete(sessionKey);
    if (session.admitted) permitsInUse -= 1;
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      permitsInUse += 1;
      waiter.resolve();
    }
    publishStats();
  }

  function wrapHandle(
    handle: SandboxBackendHandle<SO>,
    sessionKey: string,
    session: ActiveSession,
  ): SandboxBackendHandle<SO> {
    let shutdown: Promise<void> | undefined;
    return {
      ...handle,
      shutdown() {
        if (shutdown) return shutdown;
        shutdown = handle.shutdown().finally(() => release(sessionKey, session));
        return shutdown;
      },
    };
  }

  function publishStats(): void {
    options.onStats?.({ activeSessions: permitsInUse, limit, queuedSessions: waiters.length });
  }
}
