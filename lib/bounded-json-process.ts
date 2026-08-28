import { spawn } from "node:child_process";

export const DEFAULT_BOUNDED_PROCESS_TIMEOUT_MS = 60_000;
export const MIN_BOUNDED_PROCESS_TIMEOUT_MS = 1_000;
export const MAX_BOUNDED_PROCESS_TIMEOUT_MS = 300_000;

export type BoundedJsonProcessOptions = {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

/**
 * Run an operator-side helper without allowing a stalled daemon to pin its
 * parent worker. The child is its own process group so a timeout also cleans
 * up grandchildren such as the Docker CLI started by the helper.
 */
export async function runBoundedJsonProcess<T>(options: BoundedJsonProcessOptions): Promise<T> {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  if (options.signal?.aborted) throw abortError();

  return new Promise<T>((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      detached: true,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const terminate = (reason: Error) => {
      killProcessGroup(child, "SIGTERM");
      // A Docker CLI can outlive the Node wrapper when the daemon is wedged.
      // Escalate after a short grace period so the worker always regains its
      // event loop without leaving an orphaned process group behind.
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        killProcessGroup(child, "SIGKILL");
      }, 2_000);
      forceKillTimer.unref?.();
      finish(reason);
    };
    const onAbort = () => terminate(abortError());

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = `${stdout}${String(chunk)}`.slice(-2 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16 * 1024);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const suffix = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "";
        finish(new Error(`Bounded child exited with ${code ?? `signal ${signal}`}${suffix}.`));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout) as T);
      } catch {
        finish(new Error("Bounded child returned invalid JSON."));
      }
    });

    timer = setTimeout(() => {
      terminate(new Error(`Bounded child exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function boundedTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_BOUNDED_PROCESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) ||
      timeoutMs < MIN_BOUNDED_PROCESS_TIMEOUT_MS ||
      timeoutMs > MAX_BOUNDED_PROCESS_TIMEOUT_MS) {
    throw new Error(
      `Process timeout must be an integer from ${MIN_BOUNDED_PROCESS_TIMEOUT_MS} to ${MAX_BOUNDED_PROCESS_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}

function killProcessGroup(
  child: { readonly pid?: number; kill(signal?: NodeJS.Signals | number): boolean },
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited between the timeout and the kill.
    }
  }
}

function abortError(): Error {
  return new Error("Bounded child was cancelled.");
}
