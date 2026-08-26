import { timingSafeEqual } from "node:crypto";
import { getAgentDatabasePoolStats } from "@/server/data/agent-database";

export const runtime = "nodejs";

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
        activeResources: process.getActiveResourcesInfo?.() ?? [],
      },
      agentDatabasePools: getAgentDatabasePoolStats(),
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
