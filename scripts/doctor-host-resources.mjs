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

const disk = await readDisk();
const memory = await readMemory();
const cgroup = await readCgroupLimits();
const swap = await readSwap();
const docker = await readDocker();
const checks = {
  freeDisk: { ok: disk.availableBytes >= minFreeDiskBytes, requiredBytes: minFreeDiskBytes },
  freeMemory: { ok: memory.availableBytes >= minFreeMemoryBytes, requiredBytes: minFreeMemoryBytes },
  dockerLimits: {
    ok: !requireDockerLimits || docker.sandbox?.unlimitedCount === 0,
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

async function readMemory() {
  try {
    const source = await readFile("/proc/meminfo", "utf8");
    const values = new Map(
      [...source.matchAll(/^([A-Za-z_]+):\s+(\d+)\s+kB$/gmu)]
        .map((match) => [match[1], Number(match[2]) * 1024]),
    );
    const totalBytes = values.get("MemTotal") ?? os.totalmem();
    const availableBytes = values.get("MemAvailable") ?? os.freemem();
    return { totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes) };
  } catch {
    const totalBytes = os.totalmem();
    const availableBytes = os.freemem();
    return { totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes) };
  }
}

async function readCgroupLimits() {
  const result = {};
  for (const [name, path] of [
    ["memoryMaxBytes", "/sys/fs/cgroup/memory.max"],
    ["cpuMax", "/sys/fs/cgroup/cpu.max"],
  ]) {
    try {
      result[name] = (await readFile(path, "utf8")).trim();
    } catch {
      result[name] = null;
    }
  }
  return result;
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
      sandbox: await readDockerSandboxLimits(),
    };
  } catch (error) {
    return {
      reachable: false,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 240),
    };
  }
}

async function readDockerSandboxLimits() {
  try {
    const { stdout } = await execFileAsync(
      process.env.EVE_DOCKER_PATH?.trim() || "docker",
      ["ps", "--filter", "label=eve.sandbox", "--filter", "status=running", "--format", "{{.ID}}"],
      { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const ids = stdout.trim().split(/\s+/u).filter(Boolean).slice(0, 100);
    if (ids.length === 0) return { running: 0, inspected: 0, unlimitedCount: 0, sample: [] };
    const { stdout: inspected } = await execFileAsync(
      process.env.EVE_DOCKER_PATH?.trim() || "docker",
      ["inspect", "--format", "{{json .HostConfig}}", ...ids],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
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
    return { running: ids.length, inspected: sample.length, unlimitedCount, sample: sample.slice(0, 5) };
  } catch (error) {
    return { running: null, inspected: 0, unlimitedCount: null, sample: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 240) };
  }
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
