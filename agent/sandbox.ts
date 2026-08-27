import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  defaultBackend,
  defineSandbox,
  type SandboxBackend,
} from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { microsandbox } from "eve/sandbox/microsandbox";
import { vercel } from "eve/sandbox/vercel";
import {
  readAgentDockerResourceLimits,
  readAgentSandboxAdmissionConfig,
  readAgentSandboxBackend,
  readAgentSandboxIdleTimeoutMs,
  readAgentSandboxImage,
} from "../lib/production-config.ts";
import { withIdleSandboxShutdown } from "../lib/idle-sandbox-backend.ts";
import { withSandboxAdmission } from "../lib/sandbox-admission-backend.ts";

const execFileAsync = promisify(execFile);

/**
 * The sandbox is an Agent capability boundary, not a convenience default.
 * Keep the backend selectable for local development and hosted deployment,
 * while applying the same deny-by-default network policy to every backend.
 */
export default defineSandbox({
  description:
    "One isolated workspace per durable Agent session with deny-by-default egress.",
  backend: selectBackend(),
});

function selectBackend() {
  const selected = readAgentSandboxBackend();
  const image = readAgentSandboxImage();
  const admission = readAgentSandboxAdmissionConfig();
  const idleTimeoutMs = readAgentSandboxIdleTimeoutMs();
  if (selected === "docker") {
    return withManagedSandboxCapacity(
      withDockerResourceLimits(docker({
        ...(image ? { image } : {}),
        networkPolicy: "deny-all",
        pullPolicy: "if-not-present",
      }), readAgentDockerResourceLimits()),
      admission,
      idleTimeoutMs,
    );
  }
  if (selected === "microsandbox") {
    return withManagedSandboxCapacity(microsandbox({
      ...(image ? { image } : {}),
      cpus: 2,
      memoryMiB: 2048,
      networkPolicy: "deny-all",
      pullPolicy: "if-missing",
    }), admission, idleTimeoutMs);
  }
  if (selected === "vercel") {
    return withManagedSandboxCapacity(vercel({
      ...(image ? { image } : {}),
      networkPolicy: "deny-all",
      resources: { vcpus: 2 },
    }), admission, idleTimeoutMs);
  }
  return withManagedSandboxCapacity(defaultBackend({
    docker: { ...(image ? { image } : {}), networkPolicy: "deny-all", pullPolicy: "if-not-present" },
    microsandbox: {
      ...(image ? { image } : {}),
      cpus: 2,
      memoryMiB: 2048,
      networkPolicy: "deny-all",
      pullPolicy: "if-missing",
    },
    vercel: { ...(image ? { image } : {}), resources: { vcpus: 2 } },
  }), admission, idleTimeoutMs);
}

function withManagedSandboxCapacity<BO, SO>(
  backend: SandboxBackend<BO, SO>,
  admission: ReturnType<typeof readAgentSandboxAdmissionConfig>,
  idleTimeoutMs: number,
): SandboxBackend<BO, SO> {
  return withIdleSandboxShutdown(
    withSandboxAdmission(backend, admission.maxActive, admission.timeoutMs),
    idleTimeoutMs,
    {
      onIdleShutdownError(error, sessionKey) {
        console.warn("Sandbox idle shutdown failed", {
          message: error instanceof Error ? error.message : String(error),
          sessionKey,
        });
      },
    },
  );
}

/**
 * Eve 0.31's Docker backend intentionally exposes only image/network options.
 * Apply host resource limits immediately after a session container is created
 * or reattached, then verify Docker accepted the values before returning a
 * usable sandbox handle. This keeps untrusted commands from running in an
 * unlimited container without forking or patching Eve itself.
 */
function withDockerResourceLimits(
  backend: SandboxBackend,
  limits: ReturnType<typeof readAgentDockerResourceLimits>,
): SandboxBackend {
  return {
    ...backend,
    async create(input) {
      const handle = await backend.create(input);
      const configuredName = input.existingMetadata?.containerName;
      const containerName = typeof configuredName === "string" && configuredName.length > 0
        ? configuredName
        : input.sessionKey;
      try {
        await applyDockerResourceLimits(containerName, limits);
        return handle;
      } catch (error) {
        await handle.shutdown().catch(() => undefined);
        throw new Error(
          `Docker sandbox resource limits could not be applied to ${containerName}.`,
          { cause: error },
        );
      }
    },
  };
}

async function applyDockerResourceLimits(
  containerName: string,
  limits: ReturnType<typeof readAgentDockerResourceLimits>,
): Promise<void> {
  const dockerBinary = process.env.EVE_DOCKER_PATH?.trim() || "docker";
  const memory = `${limits.memoryBytes}b`;
  await execFileAsync(
    dockerBinary,
    [
      "update",
      "--memory", memory,
      "--memory-swap", memory,
      "--cpus", String(limits.cpus),
      "--pids-limit", String(limits.pidsLimit),
      containerName,
    ],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
  );

  const { stdout } = await execFileAsync(
    dockerBinary,
    ["inspect", "--format", "{{json .HostConfig}}", containerName],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const hostConfig = JSON.parse(stdout.trim()) as {
    readonly Memory?: unknown;
    readonly MemorySwap?: unknown;
    readonly NanoCpus?: unknown;
    readonly PidsLimit?: unknown;
  };
  const memoryBytes = Number(hostConfig.Memory ?? 0);
  const memorySwapBytes = Number(hostConfig.MemorySwap ?? 0);
  const nanoCpus = Number(hostConfig.NanoCpus ?? 0);
  const pidsLimit = Number(hostConfig.PidsLimit ?? 0);
  const expectedNanoCpus = Math.round(limits.cpus * 1_000_000_000);
  if (
    memoryBytes !== limits.memoryBytes
    || memorySwapBytes !== limits.memoryBytes
    || nanoCpus !== expectedNanoCpus
    || pidsLimit !== limits.pidsLimit
  ) {
    throw new Error(
      `Docker returned unexpected limits (memory=${memoryBytes}, swap=${memorySwapBytes}, cpus=${nanoCpus}, pids=${pidsLimit}).`,
    );
  }
}
