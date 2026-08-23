import type { AgentThread, AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";
import { AGENT_THREAD_STORAGE_VERSION } from "@oworker/open-agent-ui/agent-workspace";
import { createEveAgentMailboxRuntime } from "@/server/agent-mailbox/eve-runtime";
import { createPostgresThreadCollectionStoreFromEnvironment, type ThreadCollectionPatchRecord } from "@/server/data/thread-collection-store";
import { authenticateStandaloneRequest } from "@/server/http/standalone-request-auth";
import { parseStrictThreadCollection } from "@/server/http/thread-collection-contract";
import { rebuildSettledThreadTranscript } from "@/server/thread-transcript-repair";

export const runtime = "nodejs";

const store = createPostgresThreadCollectionStoreFromEnvironment<AgentThreadCollection>();

type RouteContext = { readonly params: Promise<{ readonly storageKey: string }> };

/**
 * Rebuild an old browser transcript from Eve's authoritative finite stream.
 *
 * The browser intentionally cannot repair this itself: a 176 MB Eve stream
 * must be consumed once on the server, compacted as it arrives, and committed
 * together with the absolute cursor. This endpoint is idempotent after the
 * coverage marker is written and never opens a following/live stream.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!store || !store.loadThread || !store.patch) {
    return problem(503, "agent_database_unavailable", "Agent transcript storage is not configured.", authenticated.setCookie);
  }
  const { storageKey } = await context.params;
  const threadId = new URL(request.url).searchParams.get("threadId")?.trim();
  if (!threadId || threadId.length > 200) {
    return problem(400, "thread_id_required", "A valid threadId is required.", authenticated.setCookie);
  }

  const record = await store.loadThread(
    authenticated.identity.tenantId,
    authenticated.identity.principalId,
    storageKey,
    threadId,
  );
  if (!record) return problem(404, "thread_not_found", "The Agent thread was not found.", authenticated.setCookie);
  const parsedCollection = parseStrictThreadCollection({
    threads: [record.thread],
    version: AGENT_THREAD_STORAGE_VERSION,
  });
  const parsed = parsedCollection?.threads[0];
  if (!parsed) return problem(422, "thread_invalid", "The stored Agent thread is invalid.", authenticated.setCookie);
  const thread = parsed;

  // A browser checkpoint only records the cursor it observed. It may be a
  // compact prefix after a dropped stream, even when its endIndex matches the
  // runtime tail. Only a server-side finite transcript rebuild is authoritative
  // enough to skip this repair path.
  if (thread.transcriptCoverage?.authoritative === true &&
      thread.transcriptCoverage.complete &&
      thread.transcriptCoverage.endIndex >= thread.session.streamIndex) {
    return Response.json(
      { revision: record.revision, thread },
      { headers: responseHeaders(record.revision, authenticated.setCookie) },
    );
  }
  if (!thread.session.sessionId) {
    return Response.json(
      { revision: record.revision, thread },
      { headers: responseHeaders(record.revision, authenticated.setCookie) },
    );
  }

  const runtime = createEveAgentMailboxRuntime();
  let boundary: Awaited<ReturnType<typeof runtime.inspect>>;
  try {
    boundary = await runtime.inspect({
      owner: authenticated.identity,
      sessionId: thread.session.sessionId,
    });
  } catch {
    return problem(502, "agent_session_boundary_unavailable", "The Agent runtime boundary could not be inspected.", authenticated.setCookie);
  }
  if (boundary.state === "running") {
    return problem(409, "agent_session_running", "An active Agent session cannot be repaired yet.", authenticated.setCookie);
  }
  if (boundary.tailIndex === undefined || !Number.isSafeInteger(boundary.tailIndex)) {
    return problem(502, "agent_session_tail_unavailable", "The Agent runtime did not provide an authoritative transcript boundary.", authenticated.setCookie);
  }
  const expectedEndIndex = boundary.tailIndex + 1;

  if (!runtime.readTranscript) {
    return problem(503, "agent_transcript_repair_unavailable", "The Agent runtime does not expose a finite transcript bridge.", authenticated.setCookie);
  }
  let rebuilt: Awaited<ReturnType<typeof rebuildSettledThreadTranscript>>;
  try {
    // A settled boundary alone does not prove that the compact UI transcript
    // contains every turn. Rebuild once from Eve's finite authoritative range;
    // the coverage marker written below makes subsequent opens O(1).
    rebuilt = await rebuildSettledThreadTranscript(
      runtime.readTranscript({ sessionId: thread.session.sessionId, startIndex: 0 }),
      expectedEndIndex,
    );
  } catch {
    return problem(502, "agent_transcript_repair_failed", "The authoritative Agent transcript could not be read.", authenticated.setCookie);
  }

  try {
    const settledBoundary = await runtime.inspect({
      owner: authenticated.identity,
      sessionId: thread.session.sessionId,
    });
    if (settledBoundary.state === "running" || settledBoundary.tailIndex === undefined ||
        settledBoundary.tailIndex + 1 !== rebuilt.endIndex) {
      return problem(409, "agent_session_changed", "The Agent session changed while its transcript was being repaired.", authenticated.setCookie);
    }
    boundary = settledBoundary;
  } catch {
    return problem(502, "agent_session_boundary_unavailable", "The Agent runtime boundary could not be verified after transcript repair.", authenticated.setCookie);
  }

  const failed = boundary.state === "terminal" && boundary.terminalStatus === "failed";
  const repairedThread: AgentThread = {
    ...thread,
    events: rebuilt.events,
    revision: (thread.revision ?? 0) + 1,
    session: { ...thread.session, streamIndex: rebuilt.endIndex },
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
  if (result.status === "conflict") {
    return problem(409, "thread_collection_conflict", "The Agent thread changed during transcript repair.", authenticated.setCookie);
  }
  const responseRevision = result.record.revision;
  return Response.json(
    { revision: responseRevision, thread: { ...repairedThread, revision: responseRevision } },
    { headers: responseHeaders(responseRevision, authenticated.setCookie) },
  );
}

function responseHeaders(revision: number, setCookie?: string): HeadersInit {
  return { "cache-control": "no-store", etag: `"${revision}"`, ...(setCookie ? { "set-cookie": setCookie } : {}) };
}

function problem(status: number, code: string, error: string, setCookie?: string): Response {
  return Response.json({ code, error, ok: false }, { headers: responseHeaders(0, setCookie), status });
}
