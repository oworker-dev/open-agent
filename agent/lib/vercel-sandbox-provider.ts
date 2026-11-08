import { createHash } from "node:crypto";
import { Sandbox, APIError, type NetworkPolicy } from "@vercel/sandbox";
import type { SandboxNetworkPolicy, SandboxProcess } from "eve/sandbox";
import { defineSandboxProvider, SandboxSessionGoneError, type SandboxConnection, type SandboxProviderImplementation } from "eve/sandbox/provider";
import { createSandboxComputePool } from "../../lib/sandbox-compute-pool.ts";
import type { AgentSandboxAdmissionConfig } from "../../lib/production-config.ts";

type Options = { readonly image?: string; readonly admission: AgentSandboxAdmissionConfig; readonly idleTimeoutMs: number };
type State = { readonly name: string };
type Extensions = { readonly name: string; setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> };
const nameFor = (id: string) => `open-agent-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
// Eve uses readonly JSON policy types; the SDK accepts a mutable JSON copy.
const sdkPolicy = (policy: SandboxNetworkPolicy): NetworkPolicy => JSON.parse(JSON.stringify(policy));
const isMissing = (error: unknown) => error instanceof APIError && error.response.status === 404 &&
  (error.json as { code?: string } | undefined)?.code === "not_found";
function credentials() {
  const token = process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return {};
}

export const ManagedVercelSandbox = defineSandboxProvider({ name: "open-agent-vercel", environment: createManagedVercelProvider });

export function createManagedVercelProvider(options: Options): SandboxProviderImplementation<
  { readonly networkPolicy: SandboxNetworkPolicy }, { readonly snapshotId: string }, State, Extensions
> {
  const pool = createSandboxComputePool({ ...options.admission, idleTimeoutMs: options.idleTimeoutMs,
    onIdleError: (error, sessionId) => console.warn("Sandbox idle stop failed", { sessionId, error: String(error) }),
  });
  async function get(name: string, signal?: AbortSignal) {
    try { return await Sandbox.get({ ...credentials(), name, signal }); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async function stop(name: string) { await (await get(name))?.stop(); }
  return {
    async prepare(ctx) {
      const sandbox = await Sandbox.create({ ...credentials(),
        image: options.image ?? `vcr.vercel.com/vercel/eve/base:${process.env.EVE_SANDBOX_IMAGE_TAG?.trim() || "dockerfile-fc0279bf1664"}`,
        env: { AI_AGENT: "eve" }, networkPolicy: "allow-all", resources: { vcpus: 2 },
      });
      const connection = vercelConnection(sandbox);
      try {
        const initialized = await sandbox.runCommand({ cmd: "bash", args: ["-lc", "mkdir -p /workspace && test /dev/fd -ef /proc/self/fd"], sudo: true });
        if (initialized.exitCode !== 0) throw new Error(`Sandbox base initialization failed: ${await initialized.stderr()}`);
        await ctx.populate(connection);
        return { snapshotId: (await sandbox.snapshot({ expiration: 0 })).snapshotId };
      } finally {
        await connection.close?.();
        await sandbox.delete();
      }
    },
    async start(ctx, open, artifact) {
      const name = nameFor(ctx.session.id);
      const connection = await pool.open(ctx.session.id, async () => {
        let sandbox = await get(name);
        if (!sandbox) {
          try {
            sandbox = await Sandbox.create({ ...credentials(), name, persistent: true,
              source: { type: "snapshot", snapshotId: artifact.snapshotId },
              networkPolicy: sdkPolicy(open?.networkPolicy ?? "deny-all"), resources: { vcpus: 2 }, env: { AI_AGENT: "eve" },
              keepLastSnapshots: { count: 1, expiration: 0 },
            });
          } catch (error) {
            if (!(error instanceof APIError) || error.response.status !== 409) throw error;
            sandbox = await get(name);
            if (!sandbox) throw error;
          }
        }
        return vercelConnection(sandbox);
      }, () => stop(name));
      return { connection, state: { name } };
    },
    async resume(ctx, _artifact, state) {
      if (state.name !== nameFor(ctx.session.id)) throw new Error("The recorded Vercel sandbox identity is invalid.");
      return pool.open(ctx.session.id, async () => {
        const sandbox = await get(state.name);
        if (!sandbox) throw new SandboxSessionGoneError(`Vercel sandbox ${state.name} is gone.`);
        return vercelConnection(sandbox);
      }, () => stop(state.name));
    },
    async onSessionEnd(ctx, state, { signal }) {
      const name = nameFor(ctx.session.id);
      if (state && state.name !== name) throw new Error("The recorded Vercel sandbox identity is invalid.");
      await pool.destroy(ctx.session.id, async () => { await (await get(name, signal))?.delete({ signal, deleteOrphanSnapshots: true }); });
    },
  };
}

export function vercelConnection(sandbox: Sandbox): SandboxConnection<Extensions> {
  const processes = new Set<SandboxProcess>();
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("The Vercel connection is closed."); };
  return {
    extensions: { name: sandbox.name, async setNetworkPolicy(policy) { assertOpen(); await sandbox.update({ networkPolicy: sdkPolicy(policy) }); } },
    async spawn(input) {
      assertOpen(); input.signal?.throwIfAborted();
      const command = await sandbox.runCommand({ cmd: "bash", args: ["-lc", input.command], cwd: input.workingDirectory,
        env: input.env, detached: true, stdin: input.stdin, signal: input.signal,
      });
      const stdout = new TransformStream<Uint8Array, Uint8Array>();
      const stderr = new TransformStream<Uint8Array, Uint8Array>();
      const out = stdout.writable.getWriter(); const err = stderr.writable.getWriter();
      const encode = new TextEncoder();
      // SDK logs are text chunks. Pump once and preserve each stream's ordering.
      const logs = (async () => {
        try {
          for await (const log of command.logs()) await (log.stream === "stdout" ? out : err).write(encode.encode(log.data));
          await Promise.all([out.close(), err.close()]);
        } catch (error) { await Promise.allSettled([out.abort(error), err.abort(error)]); throw error; }
      })();
      void logs.catch(() => undefined);
      let killing: Promise<void> | undefined;
      const kill = () => killing ??= command.kill("SIGKILL");
      const abort = () => { void kill().catch((error) => console.warn("Vercel process cancellation failed", String(error))); };
      input.signal?.addEventListener("abort", abort, { once: true });
      const completed = command.wait();
      void completed.finally(() => { processes.delete(process); input.signal?.removeEventListener("abort", abort); }).catch(() => undefined);
      const process: SandboxProcess = {
        stdout: stdout.readable, stderr: stderr.readable, kill,
        ...(input.stdin ? { stdin: new WritableStream<Uint8Array>({ write: (bytes) => command.writeStdin(bytes), close: () => command.closeStdin() }) } : {}),
        async wait() { const result = await completed; input.signal?.throwIfAborted(); return { exitCode: result.exitCode }; },
      };
      processes.add(process);
      if (input.signal?.aborted) abort();
      return process;
    },
    readFile(input) { assertOpen(); return sandbox.readFileToBuffer({ path: input.path }, { signal: input.signal }); },
    async writeFiles({ files, signal }) { assertOpen(); await sandbox.writeFiles(files.map((file) => ({ path: file.path, content: Buffer.from(file.content) })), { signal }); },
    async removePath({ path, force, recursive, signal }) {
      assertOpen();
      const result = await sandbox.runCommand({ cmd: "rm", args: [...(force ? ["-f"] : []), ...(recursive ? ["-r"] : []), "--", path], signal });
      if (result.exitCode !== 0) throw new Error(await result.stderr());
    },
    async stop() { await sandbox.stop(); },
    async close() { if (closed) return; await Promise.all([...processes].map((process) => process.kill())); closed = true; },
  };
}
