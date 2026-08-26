import type { AgentThread, AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";
import { AGENT_THREAD_STORAGE_VERSION } from "@oworker/open-agent-ui/agent-workspace";
import { createEveAgentMailboxRuntime } from "@/server/agent-mailbox/eve-runtime";
import { createPostgresThreadCollectionStoreFromEnvironment, type ThreadCollectionPatchRecord } from "@/server/data/thread-collection-store";
import { authenticateHostRequest, HOST_AGENT_SCOPE, requireHostScope } from "@/server/http/host-request-auth";
import { parseStrictThreadCollection } from "@/server/http/thread-collection-contract";
import { rebuildSettledThreadTranscript } from "@/server/thread-transcript-repair";

export const runtime = "nodejs";

const store = createPostgresThreadCollectionStoreFromEnvironment<AgentThreadCollection>();

type RouteContext = { readonly params: Promise<{ readonly storageKey: string }> };

/**
 * Rebuild a legacy/partial host transcript from Eve's finite stream. This is
 * intentionally a separate endpoint from the normal bounded event-window
 * read: clients must never repair a settled window during ordinary hydration.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = requireHostScope(
    await authenticateHostRequest(request),
    HOST_AGENT_SCOPE.sessionWrite,
  );
  if (!authenticated.ok) return authenticated.response;
  if (!store || !store.loadThread || !store.patch) return problem(503, "agent_database_unavailable", "Agent transcript storage is not configured.");

  const { storageKey } = await context.params;
  const threadId = new URL(request.url).searchParams.get("threadId")?.trim();
  if (!threadId || threadId.length > 200) return problem(400, "thread_id_required", "A valid threadId is required.");

  const record = await store.loadThread(
    authenticated.identity.tenantId,
    authenticated.identity.principalId,
    storageKey,
    threadId,
  );
  if (!record) return problem(404, "thread_not_found", "The Agent thread was not found.");
  const parsed = parseStrictThreadCollection({
    threads: [record.thread],
    version: AGENT_THREAD_STORAGE_VERSION,
  })?.threads[0];
  if (!parsed) return problem(422, "thread_invalid", "The stored Agent thread is invalid.");

  // Server-authoritative coverage is idempotent. A bounded browser window is
  // deliberately not considered complete and must not bypass this check.
  if (parsed.transcriptCoverage?.authoritative === true &&
      parsed.transcriptCoverage.complete &&
      parsed.transcriptCoverage.endIndex >= parsed.session.streamIndex) {
    return Response.json({ revision: record.revision, thread: parsed }, { headers: responseHeaders(record.revision) });
  }
  if (!parsed.session.sessionId) {
    return Response.json({ revision: record.revision, thread: parsed }, { headers: responseHeaders(record.revision) });
  }

  const runtime = createEveAgentMailboxRuntime();
  let boundary: Awaited<ReturnType<typeof runtime.inspect>>;
  try {
    boundary = await runtime.inspect({ owner: authenticated.identity, sessionId: parsed.session.sessionId });
  } catch {
    return problem(502, "agent_session_boundary_unavailable", "The Agent runtime boundary could not be inspected.");
  }
  if (boundary.state === "running") return problem(409, "agent_session_running", "An active Agent session cannot be repaired yet.");
  if (boundary.tailIndex === undefined || !Number.isSafeInteger(boundary.tailIndex)) {
    return problem(502, "agent_session_tail_unavailable", "The Agent runtime did not provide an authoritative transcript boundary.");
  }
  if (!runtime.readTranscript) return problem(503, "agent_transcript_repair_unavailable", "The Agent runtime does not expose a finite transcript bridge.");

  let rebuilt: Awaited<ReturnType<typeof rebuildSettledThreadTranscript>>;
  try {
    rebuilt = await rebuildSettledThreadTranscript(
      runtime.readTranscript({ sessionId: parsed.session.sessionId, startIndex: 0 }),
      boundary.tailIndex + 1,
    );
  } catch {
    return problem(502, "agent_transcript_repair_failed", "The authoritative Agent transcript could not be read.");
  }

  try {
    const verified = await runtime.inspect({ owner: authenticated.identity, sessionId: parsed.session.sessionId });
    if (verified.state === "running" || verified.tailIndex === undefined || verified.tailIndex + 1 !== rebuilt.endIndex) {
      return problem(409, "agent_session_changed", "The Agent session changed while its transcript was being repaired.");
    }
    boundary = verified;
  } catch {
    return problem(502, "agent_session_boundary_unavailable", "The Agent runtime boundary could not be verified after transcript repair.");
  }

  const failed = boundary.state === "terminal" && boundary.terminalStatus === "failed";
  const repairedThread: AgentThread = {
    ...parsed,
    events: rebuilt.events,
    revision: (parsed.revision ?? 0) + 1,
    session: { ...parsed.session, streamIndex: rebuilt.endIndex },
    status: failed ? "error" : "ready",
    transcriptCoverage: { authoritative: true, complete: true, endIndex: rebuilt.endIndex, startIndex: 0, version: 1 },
    updatedAt: Date.now(),
  };
  const patch: ThreadCollectionPatchRecord = {
    deletedThreadIds: [],
    eventAppends: [{ events: rebuilt.events, replaceFrom: 0, threadId }],
    upsertThreads: [{ ...repairedThread, events: [], hydration: "summary" }],
  };
  const result = await store.patch(
    authenticated.identity.tenantId,
    authenticated.identity.principalId,
    storageKey,
    record.revision,
    patch,
  );
  if (result.status === "conflict") return problem(409, "thread_collection_conflict", "The Agent thread changed during transcript repair.", responseHeaders(result.currentRevision));
  const responseRevision = result.record.revision;
  return Response.json(
    { revision: responseRevision, thread: { ...repairedThread, revision: responseRevision } },
    { headers: responseHeaders(responseRevision) },
  );
}

function responseHeaders(revision: number): HeadersInit {
  return { "cache-control": "no-store", etag: `"${revision}"` };
}

function problem(status: number, code: string, error: string, headers?: HeadersInit): Response {
  return Response.json({ code, error, ok: false }, { headers: { "cache-control": "no-store", ...headers }, status });
}
