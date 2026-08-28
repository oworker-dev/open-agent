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
        activeResources: process.getActiveResourcesInfo?.() ?? [],
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

function authorized(request: Request): boolean {
  const secret = process.env.AGENT_METRICS_SECRET?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(secret);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
