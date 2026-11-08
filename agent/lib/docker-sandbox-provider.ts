import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Readable, Transform, Writable } from "node:stream";
import { promisify } from "node:util";
import { defineSandboxProvider, SandboxSessionGoneError, type SandboxConnection, type SandboxProviderImplementation } from "eve/sandbox/provider";
import type { SandboxProcess } from "eve/sandbox";
import type { AgentDockerResourceLimits, AgentSandboxAdmissionConfig } from "../../lib/production-config.ts";
import { createSandboxComputePool } from "../../lib/sandbox-compute-pool.ts";

const execute = promisify(execFile);
// The sandbox image tag pinned by Eve 0.85.0, independent of its package version.
export const DEFAULT_AGENT_SANDBOX_IMAGE = "ghcr.io/vercel/eve:dockerfile-fc0279bf1664";
type Options = { readonly image: string; readonly limits: AgentDockerResourceLimits; readonly admission: AgentSandboxAdmissionConfig; readonly idleTimeoutMs: number };
type State = { readonly name: string };
type Inspect = { State: { Running: boolean }; Config: { Labels?: Record<string, string> }; HostConfig: { Memory: number; MemorySwap: number; NanoCpus: number; PidsLimit: number } };
const nameFor = (id: string) => `eve-sbx-ses-docker-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
const binary = () => process.env.EVE_DOCKER_PATH?.trim() || "docker";

async function docker(args: readonly string[], signal?: AbortSignal) {
  return execute(binary(), [...args], { timeout: 120_000, maxBuffer: 256 * 1024 * 1024, signal, encoding: "buffer" });
}
async function inspect(name: string): Promise<Inspect | undefined> {
  try { return JSON.parse((await docker(["inspect", name])).stdout.toString())[0] as Inspect; }
  catch (error) {
    if (error && typeof error === "object" && "stderr" in error && /No such (?:object|container)/i.test(String(error.stderr))) return undefined;
    throw error;
  }
}
async function stopContainer(name: string) {
  if (!(await inspect(name))?.State.Running) return;
  await docker(["stop", "-t", "0", name]);
  if ((await inspect(name))?.State.Running) throw new Error(`Docker sandbox ${name} is still running.`);
}
function assertOwned(container: Inspect, sessionId: string, limits: AgentDockerResourceLimits) {
  const labels = container.Config.Labels;
  if (labels?.["eve.sandbox"] !== "1" || labels["eve.sandbox.tag.sessionId"] !== sessionId) throw new Error("The sandbox container belongs to another session.");
  const config = container.HostConfig;
  if (config.Memory !== limits.memoryBytes || config.MemorySwap !== limits.memoryBytes ||
      config.NanoCpus !== Math.round(limits.cpus * 1e9) || config.PidsLimit !== limits.pidsLimit) {
    throw new Error("The Docker sandbox resource limits do not match the deployment policy.");
  }
}

/** Public v27 provider lifecycle; limits apply before any container process runs. */
export const ManagedDockerSandbox = defineSandboxProvider({
  name: "open-agent-docker",
  environment: createManagedDockerProvider,
});

export function createManagedDockerProvider(options: Options): SandboxProviderImplementation<
  { readonly networkPolicy: "allow-all" | "deny-all" }, { readonly image: string }, State, {}
> {
    const pool = createSandboxComputePool({ ...options.admission, idleTimeoutMs: options.idleTimeoutMs,
      onIdleError: (error, sessionId) => console.warn("Sandbox idle stop failed", { sessionId, error: String(error) }),
    });
    async function stopOwned(name: string, sessionId: string) {
      const container = await inspect(name);
      if (!container) return;
      assertOwned(container, sessionId, options.limits);
      await stopContainer(name);
    }
    async function create(name: string, image: string, network: "allow-all" | "deny-all", role: string, sessionId?: string) {
      const limits = options.limits;
      await docker(["run", "-d", "--init", "--name", name,
        "--memory", `${limits.memoryBytes}b`, "--memory-swap", `${limits.memoryBytes}b`,
        "--cpus", String(limits.cpus), "--pids-limit", String(limits.pidsLimit),
        "--label", "eve.sandbox=1", "--label", `eve.sandbox.role=${role}`,
        ...(sessionId ? ["--label", `eve.sandbox.tag.sessionId=${sessionId}`] : []),
        ...(network === "deny-all" ? ["--network", "none"] : []),
        "--env", "AI_AGENT=eve", "--workdir", "/workspace", "--entrypoint", "/bin/sh", image, "-c", "sleep 2147483647"]);
    }
    return {
      async prepare(ctx) {
        const image = `open-agent-sandbox-template:${ctx.templateKey({ image: options.image, limits: options.limits, protocol: 1 }).slice(0, 48)}`;
        try { await docker(["image", "inspect", image]); return { image }; }
        catch (error) {
          if (!error || typeof error !== "object" || !("stderr" in error) || !/No such image|No such object/i.test(String(error.stderr))) throw error;
        }
        const name = `eve-sbx-tpl-open-agent-${randomUUID()}`;
        try {
          await create(name, options.image, "allow-all", "template-build");
          // A custom image follows the same Linux tool contract as Eve's base.
          await docker(["exec", "--user", "root", name, "sh", "-ec",
            'command -v bash; command -v python3; command -v setsid; id vercel-sandbox >/dev/null; mkdir -p /workspace; chown vercel-sandbox /workspace']);
          const connection = dockerConnection(name);
          try { await ctx.populate(connection); }
          finally { await connection.close?.(); }
          await docker(["commit", name, image]);
          return { image };
        } finally { await docker(["rm", "-f", name]).catch(() => undefined); }
      },
      async start(ctx, open: { readonly networkPolicy: "allow-all" | "deny-all" } | undefined, artifact) {
        const name = nameFor(ctx.session.id);
        const connection = await pool.open(ctx.session.id, async () => {
          let container = await inspect(name);
          if (!container) {
            try { await create(name, artifact.image, open?.networkPolicy ?? "deny-all", "session", ctx.session.id); }
            catch (error) { if (!await inspect(name)) throw error; }
            container = await inspect(name);
          }
          if (!container) throw new SandboxSessionGoneError("The newly created Docker sandbox is missing.");
          assertOwned(container, ctx.session.id, options.limits);
          if (!container.State.Running) await docker(["start", name]);
          return dockerConnection(name);
        }, () => stopOwned(name, ctx.session.id));
        return { connection, state: { name } };
      },
      async resume(ctx, _artifact, state: State) {
        if (state.name !== nameFor(ctx.session.id)) throw new Error("The recorded Docker sandbox identity is invalid.");
        return pool.open(ctx.session.id, async () => {
          const container = await inspect(state.name);
          if (!container) throw new SandboxSessionGoneError(`Docker sandbox ${state.name} is gone.`);
          assertOwned(container, ctx.session.id, options.limits);
          if (!container.State.Running) await docker(["start", state.name]);
          return dockerConnection(state.name);
        }, () => stopOwned(state.name, ctx.session.id));
      },
      async onSessionEnd(ctx, state, { signal }) {
        const name = nameFor(ctx.session.id);
        if (state && state.name !== name) throw new Error("The recorded Docker sandbox identity is invalid.");
        await pool.destroy(ctx.session.id, async () => {
          const container = await inspect(name);
          if (!container) return;
          assertOwned(container, ctx.session.id, options.limits);
          await docker(["rm", "-f", name], signal);
        });
      },
    };
}

const KILL_PROCESS_TREE = `import os, signal, sys

def kill_tree(pid):
    try:
        os.kill(pid, signal.SIGSTOP)
    except ProcessLookupError:
        return
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(entry.path + "/status") as status:
                parent = next(line for line in status if line.startswith("PPid:")).split()[1]
            if int(parent) == pid:
                kill_tree(int(entry.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

kill_tree(int(sys.argv[1]))
`;

/** Each connection owns only its exec processes. Closing it preserves compute. */
export function dockerConnection(name: string): SandboxConnection {
  const processes = new Set<SandboxProcess>();
  let closed = false;
  const execArgs = ["exec", "--user", "vercel-sandbox"];
  const assertOpen = () => { if (closed) throw new Error("The Docker connection is closed."); };
  return {
    async spawn(input) {
      assertOpen(); input.signal?.throwIfAborted();
      const args = [...execArgs, ...(input.stdin ? ["-i"] : []), "--workdir", input.workingDirectory];
      for (const [key, value] of Object.entries(input.env)) args.push("--env", `${key}=${value}`);
      // setsid may fork when Docker makes it a process-group leader. Keep the
      // exec alive until that child exits, or Docker reports success while the
      // command keeps running with its output detached.
      args.push(name, "setsid", "--wait", "bash", "-c", 'printf "OPEN_AGENT_PID=%s\\n" "$$"; exec bash -lc "$1"', "open-agent", input.command);
      const child = spawn(binary(), args, { stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
      let pid: number | undefined;
      let finished = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      let header = Buffer.alloc(0);
      const stdout = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        if (pid !== undefined) return callback(null, chunk);
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf(10);
        if (end < 0 && header.length < 128) return callback();
        const match = /^OPEN_AGENT_PID=(\d+)$/u.exec(header.subarray(0, end).toString());
        if (!match) { const error = new Error("Docker exec did not report its process identity."); rejectReady(error); return callback(error); }
        pid = Number(match[1]); resolveReady(); callback(null, header.subarray(end + 1));
      } });
      const stderr = new PassThrough();
      child.stdout!.pipe(stdout); child.stderr!.pipe(stderr);
      const completed = new Promise<{ exitCode: number }>((resolve, reject) => {
        child.once("error", (error) => { rejectReady(error); reject(error); });
        child.once("close", (code) => { finished = true; rejectReady(new Error(`Docker exec exited before startup (${code}).`)); resolve({ exitCode: code ?? 137 }); });
      });
      // Attach before awaiting startup so spawn failures never reject unobserved.
      void completed.catch(() => undefined);
      let killing: Promise<void> | undefined;
      const kill = () => killing ??= (async () => {
        await ready.catch(() => undefined);
        if (finished) return;
        // Bash job control and setsid can move descendants to other process
        // groups. Freeze each parent before walking /proc so its children
        // cannot fork or be reparented while the tree is being terminated.
        if (pid !== undefined) await docker([...execArgs, name, "python3", "-c", KILL_PROCESS_TREE, String(pid)]);
        child.kill("SIGKILL");
        await completed;
      })();
      const abort = () => { void kill().catch((error) => console.warn("Docker process cancellation failed", String(error))); };
      input.signal?.addEventListener("abort", abort, { once: true });
      const process: SandboxProcess = {
        ...(input.stdin && child.stdin ? { stdin: Writable.toWeb(child.stdin) } : {}),
        stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>, stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
        async wait() { const result = await completed; if (killing) await killing; input.signal?.throwIfAborted(); return result; }, kill,
      };
      processes.add(process);
      void completed.finally(() => { processes.delete(process); input.signal?.removeEventListener("abort", abort); }).catch(() => undefined);
      if (input.signal?.aborted) abort();
      try { await ready; return process; }
      catch (error) { child.kill("SIGKILL"); throw error; }
    },
    async readFile({ path, signal }) {
      assertOpen();
      try {
        return (await docker([...execArgs, name, "python3", "-c", 'import sys\ntry:\n f=open(sys.argv[1],"rb")\nexcept FileNotFoundError:\n sys.exit(44)\nwith f: sys.stdout.buffer.write(f.read())', path], signal)).stdout;
      } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === 44) return null; throw error; }
    },
    async writeFiles({ files, signal }) {
      assertOpen(); signal?.throwIfAborted();
      const process = await this.spawn({ stdin: true, command: `python3 -c 'import sys,json,base64,pathlib; files=json.load(sys.stdin); [(pathlib.Path(f["path"]).parent.mkdir(parents=True,exist_ok=True),pathlib.Path(f["path"]).write_bytes(base64.b64decode(f["content"]))) for f in files]'`, workingDirectory: "/workspace", env: {}, signal });
      const writer = process.stdin!.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(files.map((file) => ({ path: file.path, content: Buffer.from(file.content).toString("base64") })))));
      await writer.close();
      // Drain both output streams so write-side backpressure cannot stall wait.
      const drain = (stream: ReadableStream<Uint8Array>) => stream.pipeTo(new WritableStream({ write() {} }));
      const [result] = await Promise.all([process.wait(), drain(process.stdout), drain(process.stderr)]);
      if (result.exitCode !== 0) throw new Error(`Docker writeFiles failed (${result.exitCode}).`);
    },
    async removePath({ path, recursive, force, signal }) {
      assertOpen(); await docker([...execArgs, name, "rm", ...(recursive ? ["-r"] : []), ...(force ? ["-f"] : []), "--", path], signal);
    },
    stop: () => stopContainer(name),
    async close() { if (closed) return; closed = true; await Promise.all([...processes].map((process) => process.kill())); },
  };
}
