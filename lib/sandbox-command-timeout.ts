export class SandboxCommandTimeoutError extends Error {
  readonly code = "SANDBOX_COMMAND_TIMEOUT";

  constructor(timeoutMs: number) {
    super(`Sandbox command exceeded the ${timeoutMs}ms time limit and was terminated.`);
    this.name = "SandboxCommandTimeoutError";
  }
}

/**
 * Adds a wall-clock deadline while preserving Eve's turn cancellation signal.
 * The executor must honor the supplied signal; Eve's sandbox implementations
 * terminate the command before its promise settles on abort.
 */
export async function withSandboxCommandTimeout<T>(input: {
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly parentSignal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<T> {
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    timeoutController.abort(new DOMException("Sandbox command timed out.", "TimeoutError"));
  }, input.timeoutMs);
  timeoutTimer.unref?.();
  const signal = AbortSignal.any([input.parentSignal, timeoutController.signal]);
  try {
    const result = await input.execute(signal);
    if (timeoutController.signal.aborted && !input.parentSignal.aborted) {
      throw new SandboxCommandTimeoutError(input.timeoutMs);
    }
    return result;
  } catch (error) {
    if (timeoutController.signal.aborted && !input.parentSignal.aborted) {
      throw new SandboxCommandTimeoutError(input.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
  }
}
