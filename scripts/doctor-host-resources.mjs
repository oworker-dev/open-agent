import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const minFreeDiskBytes = boundedBytes(
  process.env.AGENT_HOST_MIN_FREE_DISK_BYTES,
  2 * 1024 ** 3,
  0,
  100 * 1024 ** 4,
);
const minFreeMemoryBytes = boundedBytes(
  process.env.AGENT_HOST_MIN_FREE_MEMORY_BYTES,
  512 * 1024 ** 2,
  0,
  100 * 1024 ** 4,
);
const requireDockerLimits = process.env.AGENT_HOST_REQUIRE_DOCKER_LIMITS === "1";
const configuredDockerLimits = requireDockerLimits ? readConfiguredDockerLimits() : null;

const disk = await readDisk();
const cgroup = await readCgroupLimits();
const memory = await readMemory(cgroup);
const swap = await readSwap();
const docker = await readDocker();
const checks = {
  freeDisk: { ok: disk.availableBytes >= minFreeDiskBytes, requiredBytes: minFreeDiskBytes },
  freeMemory: { ok: memory.availableBytes >= minFreeMemoryBytes, requiredBytes: minFreeMemoryBytes },
  dockerLimits: {
    ok: !requireDockerLimits
      || (docker.sandbox?.unlimitedCount === 0 && docker.sandbox?.mismatchCount === 0),
    required: requireDockerLimits,
  },
};
const report = {
  schemaVersion: "open-agent.host-resource-diagnostics.v1",
  generatedAt: new Date().toISOString(),
  cpu: { logical: os.cpus().length, availableParallelism: os.availableParallelism?.() ?? os.cpus().length },
  memory,
  cgroup,
  swap,
  disk,
  docker,
  checks,
  ok: checks.freeDisk.ok && checks.freeMemory.ok && checks.dockerLimits.ok,
  note: "Read-only diagnostics. Values are host observations, not a capacity or user-count guarantee.",
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

async function readDisk() {
  const stats = await statfs(root);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return { availableBytes, totalBytes, usedBytes: Math.max(0, totalBytes - availableBytes) };
}

async function readMemory(cgroup = {}) {
  try {
    const source = await readFile("/proc/meminfo", "utf8");
    const values = new Map(
      [...source.matchAll(/^([A-Za-z_]+):\s+(\d+)\s+kB$/gmu)]
        .map((match) => [match[1], Number(match[2]) * 1024]),
    );
    const hostTotalBytes = values.get("MemTotal") ?? os.totalmem();
    const hostAvailableBytes = values.get("MemAvailable") ?? os.freemem();
    const cgroupLimit = Number.isSafeInteger(cgroup.memoryLimitBytes) ? cgroup.memoryLimitBytes : undefined;
    const cgroupCurrent = Number.isSafeInteger(cgroup.memoryCurrentBytes) ? cgroup.memoryCurrentBytes : undefined;
    const totalBytes = cgroupLimit && cgroupLimit > 0 ? Math.min(hostTotalBytes, cgroupLimit) : hostTotalBytes;
    const availableBytes = cgroupLimit && cgroupCurrent !== undefined
      ? Math.max(0, Math.min(hostAvailableBytes, cgroupLimit - cgroupCurrent))
      : hostAvailableBytes;
    return {
      totalBytes,
      availableBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      hostTotalBytes,
      hostAvailableBytes,
    };
  } catch {
    const hostTotalBytes = os.totalmem();
    const hostAvailableBytes = os.freemem();
    const cgroupLimit = Number.isSafeInteger(cgroup.memoryLimitBytes) ? cgroup.memoryLimitBytes : undefined;
    const cgroupCurrent = Number.isSafeInteger(cgroup.memoryCurrentBytes) ? cgroup.memoryCurrentBytes : undefined;
    const totalBytes = cgroupLimit && cgroupLimit > 0 ? Math.min(hostTotalBytes, cgroupLimit) : hostTotalBytes;
    const availableBytes = cgroupLimit && cgroupCurrent !== undefined
      ? Math.max(0, Math.min(hostAvailableBytes, cgroupLimit - cgroupCurrent))
      : hostAvailableBytes;
    return { totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes), hostTotalBytes, hostAvailableBytes };
  }
}

async function readCgroupLimits() {
  const memoryMaxRaw = await readFirstAvailable(["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
  const memoryCurrentRaw = await readFirstAvailable(["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
  const cpuMaxRaw = await readFirstAvailable(["/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"]);
  const memoryLimitBytes = parseCgroupBytes(memoryMaxRaw);
  const memoryCurrentBytes = parseCgroupBytes(memoryCurrentRaw);
  return {
    memoryMax: memoryMaxRaw,
    memoryCurrent: memoryCurrentRaw,
    memoryLimitBytes,
    memoryCurrentBytes,
    cpuMax: cpuMaxRaw,
    cpuQuota: parseCpuQuota(cpuMaxRaw),
  };
}

async function readFirstAvailable(paths) {
  for (const path of paths) {
    try {
      return (await readFile(path, "utf8")).trim();
    } catch {
      // Try the next cgroup layout (v2 then v1).
    }
  }
  return null;
}

function parseCgroupBytes(raw) {
  if (!raw || raw === "max") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseCpuQuota(raw) {
  if (!raw) return null;
  const fields = raw.split(/\s+/u);
  if (fields.length >= 2 && fields[0] !== "max") {
    const quota = Number(fields[0]);
    const period = Number(fields[1]);
    return Number.isFinite(quota) && Number.isFinite(period) && quota > 0 && period > 0
      ? quota / period
      : null;
  }
  const quota = Number(fields[0]);
  return Number.isFinite(quota) && quota > 0 ? quota : null;
}

async function readSwap() {
  try {
    const source = await readFile("/proc/swaps", "utf8");
    const lines = source.trim().split("\n").slice(1).filter(Boolean);
    return { enabled: lines.length > 0, entries: lines.length };
  } catch {
    return { enabled: null, entries: null };
  }
}

async function readDocker() {
  try {
    const { stdout } = await execFileAsync(
      process.env.EVE_DOCKER_PATH?.trim() || "docker",
      ["info", "--format", "{{json .}}"],
      { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const info = JSON.parse(stdout);
    return {
      reachable: true,
      serverVersion: info.ServerVersion ?? null,
      cpus: info.NCPU ?? null,
      memoryBytes: info.MemTotal ?? null,
      sandbox: await readDockerSandboxLimits(configuredDockerLimits),
    };
  } catch (error) {
    return {
      reachable: false,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
    };
  }
}

async function readDockerSandboxLimits(expected) {
  try {
    const { stdout } = await execFileAsync(
      process.env.EVE_DOCKER_PATH?.trim() || "docker",
      ["ps", "--filter", "label=eve.sandbox", "--filter", "status=running", "--format", "{{.ID}}"],
      { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const ids = stdout.trim().split(/\s+/u).filter(Boolean);
    if (ids.length === 0) return {
      running: 0,
      inspected: 0,
      unlimitedCount: 0,
      mismatchCount: 0,
      expected,
      sample: [],
    };
    const { stdout: inspected } = await execFileAsync(
      process.env.EVE_DOCKER_PATH?.trim() || "docker",
      ["inspect", "--format", "{{json .HostConfig}}", ...ids],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const sample = inspected.trim().split("\n").filter(Boolean).map((line) => {
      const hostConfig = JSON.parse(line);
      return {
        memoryBytes: Number(hostConfig.Memory ?? 0),
        nanoCpus: Number(hostConfig.NanoCpus ?? 0),
        pidsLimit: hostConfig.PidsLimit == null ? null : Number(hostConfig.PidsLimit),
      };
    });
    const unlimitedCount = sample.filter((entry) =>
      entry.memoryBytes <= 0 || entry.nanoCpus <= 0 || entry.pidsLimit == null || entry.pidsLimit <= 0,
    ).length;
    const mismatchCount = expected === null ? 0 : sample.filter((entry) =>
      entry.memoryBytes !== expected.memoryBytes
      || entry.nanoCpus !== expected.nanoCpus
      || entry.pidsLimit !== expected.pidsLimit,
    ).length;
    return {
      running: ids.length,
      inspected: sample.length,
      unlimitedCount,
      mismatchCount,
      expected,
      sample: sample.slice(0, 5),
    };
  } catch (error) {
    return {
      running: null,
      inspected: 0,
      unlimitedCount: null,
      mismatchCount: null,
      expected,
      sample: [],
      error: (error instanceof Error ? error.message : String(error)).slice(0, 240),
    };
  }
}

function readConfiguredDockerLimits() {
  const memoryBytes = boundedBytes(
    process.env.AGENT_DOCKER_MEMORY_LIMIT_BYTES,
    0,
    64 * 1024 ** 3,
  );
  if (memoryBytes <= 0) {
    throw new Error("AGENT_DOCKER_MEMORY_LIMIT_BYTES is required when AGENT_HOST_REQUIRE_DOCKER_LIMITS=1.");
  }
  const cpusRaw = process.env.AGENT_DOCKER_CPU_LIMIT?.trim();
  const cpus = cpusRaw ? Number(cpusRaw) : NaN;
  if (!Number.isFinite(cpus) || cpus < 0.1 || cpus > 64) {
    throw new Error("AGENT_DOCKER_CPU_LIMIT must be a number from 0.1 to 64 when AGENT_HOST_REQUIRE_DOCKER_LIMITS=1.");
  }
  const pidsRaw = process.env.AGENT_DOCKER_PIDS_LIMIT?.trim();
  const pidsLimit = pidsRaw ? Number(pidsRaw) : NaN;
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 64 || pidsLimit > 32_768) {
    throw new Error("AGENT_DOCKER_PIDS_LIMIT must be an integer from 64 to 32768 when AGENT_HOST_REQUIRE_DOCKER_LIMITS=1.");
  }
  return { memoryBytes, nanoCpus: Math.round(cpus * 1_000_000_000), pidsLimit };
}

function boundedBytes(raw, fallback, minimum, maximum) {
  if (!raw?.trim()) return fallback;
  const match = /^(\d+)(?:\s*(KiB|MiB|GiB|TiB))?$/iu.exec(raw.trim());
  if (!match) {
    throw new Error(
      "Resource byte thresholds must be an integer with an optional KiB, MiB, GiB, or TiB suffix.",
    );
  }
  const multiplier = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }[
    match[2]?.toLowerCase()
  ] ?? 1;
  const value = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Resource byte threshold must be between ${minimum} and ${maximum}.`);
  }
  return value;
}
