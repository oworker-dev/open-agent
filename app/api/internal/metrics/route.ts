import { timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  getAgentDatabasePoolStats,
  getAgentRunAdmissionStats,
  readAgentDatabaseConfig,
} from "@/server/data/agent-database";
import {
  getWorkflowDatabasePoolStats,
  getWorkflowRuntimeStats,
  readWorkflowDatabaseConfig,
} from "@/server/data/workflow-database";
import { getSandboxAdmissionStats } from "@/lib/sandbox-admission-backend";

export const runtime = "nodejs";

const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

/**
 * Protected, low-cardinality diagnostics for capacity verification. This is
 * intentionally not a Prometheus endpoint and never includes prompts,
 * messages, tenant identifiers, or credentials. Export OTel metrics for
 * long-term monitoring; this route is only a point-in-time load-test sample.
 */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json(
      { code: "metrics_unauthorized", error: "A valid metrics credential is required.", ok: false },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const usage = process.memoryUsage();
  const cpu = process.cpuUsage();
  const activeResources = process.getActiveResourcesInfo?.() ?? [];
  const activeResourceCounts = countActiveResources(activeResources);
  const eventLoopP95Ms = Number((eventLoop.percentile(95) / 1e6).toFixed(2));
  const eventLoopMaxMs = Number((eventLoop.max / 1e6).toFixed(2));
  eventLoop.reset();
  const databaseConfig = readAgentDatabaseConfig();
  let agentRuns;
  if (databaseConfig) {
    try {
      agentRuns = await getAgentRunAdmissionStats(databaseConfig);
    } catch {
      // Diagnostics must remain available during a database incident. The
      // absence of counters is explicit and never represented as zero work.
      agentRuns = { available: false as const };
    }
  } else {
    agentRuns = { available: false as const };
  }
  const workflowDatabaseConfig = readWorkflowDatabaseConfig();
  let workflowRuns;
  if (workflowDatabaseConfig) {
    try {
      workflowRuns = await getWorkflowRuntimeStats(workflowDatabaseConfig);
    } catch {
      workflowRuns = { available: false as const };
    }
  } else {
    workflowRuns = { available: false as const };
  }
  return Response.json(
    {
      ok: true,
      capturedAt: new Date().toISOString(),
      process: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        externalBytes: usage.external,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        eventLoopP95Ms,
        eventLoopMaxMs,
        // Keep diagnostics O(number of resource types), not O(number of open
        // sockets/timers). A raw resource list becomes a large response under
        // a stream fan-out load and can distort the very measurement it serves.
        activeResources: {
          total: activeResources.length,
          byType: activeResourceCounts,
        },
      },
      agentDatabasePools: getAgentDatabasePoolStats(),
      agentRuns,
      workflowDatabasePools: getWorkflowDatabasePoolStats(),
      workflowRuns,
      sandboxAdmission: getSandboxAdmissionStats() ?? { available: false as const },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function countActiveResources(resources: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const resource of resources) {
    if (typeof resource !== "string" || resource.length === 0) continue;
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function authorized(request: Request): boolean {
  const secret = process.env.AGENT_METRICS_SECRET?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
