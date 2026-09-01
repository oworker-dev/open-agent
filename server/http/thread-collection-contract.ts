import type { AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";
import {
  AGENT_THREAD_STORAGE_VERSION,
  compactThreadEvents,
  parseThreadCollection,
} from "@oworker/open-agent-ui/agent-workspace";

export type ThreadCollectionPatch = {
  readonly activeThreadId: string | null;
  readonly deletedThreadIds: readonly string[];
  readonly eventAppends: readonly {
    readonly events: AgentThreadCollection["threads"][number]["events"];
    readonly replaceFrom?: number;
    readonly threadId: string;
  }[];
  readonly upsertThreads: AgentThreadCollection["threads"];
};

export function parseStrictThreadCollection(value: unknown): AgentThreadCollection | undefined {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== AGENT_THREAD_STORAGE_VERSION) ||
    !Array.isArray(value.threads)
  ) return undefined;
  const parsed = parseThreadCollection(value);
  return parsed.threads.length === value.threads.length ? parsed : undefined;
}

export function parseThreadCollectionPatch(value: unknown): ThreadCollectionPatch | undefined {
  if (
    !isRecord(value) ||
    value.version !== AGENT_THREAD_STORAGE_VERSION ||
    (value.activeThreadId !== null && typeof value.activeThreadId !== "string") ||
    !Array.isArray(value.deletedThreadIds) ||
    !Array.isArray(value.upsertThreads) ||
    (value.eventAppends !== undefined && !Array.isArray(value.eventAppends))
  ) return undefined;
  const deletedThreadIds = value.deletedThreadIds.filter((id): id is string =>
    typeof id === "string" && id.length > 0 && id.length <= 200
  );
  if (deletedThreadIds.length !== value.deletedThreadIds.length) return undefined;
  const parsed = parseStrictThreadCollection({
    threads: value.upsertThreads,
    version: AGENT_THREAD_STORAGE_VERSION,
  });
  if (!parsed || parsed.threads.length !== value.upsertThreads.length) return undefined;
  const eventAppends = (value.eventAppends ?? []).map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.threadId !== "string" || !Array.isArray(candidate.events)) return undefined;
    if (!candidate.threadId || candidate.threadId.length > 200) return undefined;
    const events = candidate.events as AgentThreadCollection["threads"][number]["events"];
    if (events.some((event) => !isRecord(event) || !isRecord(event.meta) || typeof event.meta.id !== "string")) return undefined;
    const replaceFrom = candidate.replaceFrom === undefined
      ? undefined
      : typeof candidate.replaceFrom === "number"
        ? candidate.replaceFrom
        : null;
    if (replaceFrom === null) return undefined;
    if (replaceFrom !== undefined && (!Number.isSafeInteger(replaceFrom) || replaceFrom < 0)) return undefined;
    return { events, ...(replaceFrom === undefined ? {} : { replaceFrom }), threadId: candidate.threadId };
  });
  if (eventAppends.some((entry) => entry === undefined)) return undefined;
  const upsertIds = parsed.threads.map((thread) => thread.id);
  const appendIds = eventAppends.map((entry) => entry!.threadId);
  if (
    new Set(deletedThreadIds).size !== deletedThreadIds.length ||
    new Set(upsertIds).size !== upsertIds.length ||
    new Set(appendIds).size !== appendIds.length ||
    deletedThreadIds.some((id) => upsertIds.includes(id) || appendIds.includes(id))
  ) return undefined;
  return {
    activeThreadId: value.activeThreadId,
    deletedThreadIds,
    eventAppends: eventAppends as ThreadCollectionPatch["eventAppends"],
    upsertThreads: parsed.threads,
  };
}

export function applyThreadCollectionPatch(
  current: AgentThreadCollection,
  patch: ThreadCollectionPatch,
): AgentThreadCollection {
  const deleted = new Set(patch.deletedThreadIds);
  const replacements = new Map(patch.upsertThreads.map((thread) => [thread.id, thread]));
  const appends = new Map(patch.eventAppends.map((entry) => [entry.threadId, entry]));
  const threads = current.threads
    .filter((thread) => !deleted.has(thread.id))
    .map((thread) => {
      const replacement = replacements.get(thread.id);
      const next = replacement
        ? replacement.hydration !== "summary"
        ? replacement
          : {
              ...mergeSummaryThread(thread, replacement),
            }
        : thread;
      const appended = appends.get(thread.id);
      return appended && appended.events.length > 0
        ? { ...next, events: compactThreadEvents([
            ...next.events.slice(0, Math.min(appended.replaceFrom ?? next.events.length, next.events.length)),
            ...appended.events,
          ]) }
        : next;
    });
  const existingIds = new Set(threads.map((thread) => thread.id));
  const inserted = patch.upsertThreads.filter((thread) =>
    thread.hydration !== "summary" && !existingIds.has(thread.id)
  );
  const merged = [...inserted, ...threads];
  const activeThreadId = patch.activeThreadId && merged.some((thread) => thread.id === patch.activeThreadId)
    ? patch.activeThreadId
    : undefined;
  return {
    ...(activeThreadId ? { activeThreadId } : {}),
    threads: merged,
    version: AGENT_THREAD_STORAGE_VERSION,
  };
}

/**
 * A summary upsert is still authoritative for thread metadata. In particular,
 * an omitted optional field means it was cleared by the client; retaining the
 * old JSON value here resurrects stale pending edits on the next refresh.
 */
function mergeSummaryThread(
  current: AgentThreadCollection["threads"][number],
  replacement: AgentThreadCollection["threads"][number],
): AgentThreadCollection["threads"][number] {
  const next: Record<string, unknown> = {
    ...current,
    closedInputRequestIds: replacement.closedInputRequestIds,
    preferences: replacement.preferences,
    queuedTurns: replacement.queuedTurns,
    revision: replacement.revision,
    session: replacement.session,
    status: replacement.status,
    title: replacement.title,
    updatedAt: replacement.updatedAt,
  };
  for (const key of ["draftRestore", "interruptedTurns", "pendingTurn", "retainedContext"] as const) {
    if (Object.prototype.hasOwnProperty.call(replacement, key)) next[key] = replacement[key];
    else delete next[key];
  }
  delete next.transcriptWindow;
  // A server repair establishes a monotonic, authoritative coverage marker.
  // Stale browser summaries must not erase it and force a completed session
  // through transcript repair on every open. An explicit edit checkpoint is
  // the one normal operation that invalidates coverage before resubmission.
  const replacingEditedTurn = replacement.pendingTurn?.state === "clearing" ||
    replacement.pendingTurn?.state === "resubmitting" ||
    (replacement.pendingTurn?.state === "submitting" && replacement.pendingTurn.operation === "edit");
  if (replacingEditedTurn) {
    delete next.transcriptCoverage;
  } else if (replacement.transcriptCoverage?.authoritative === true) {
    next.transcriptCoverage = replacement.transcriptCoverage;
  } else if (Object.prototype.hasOwnProperty.call(replacement, "transcriptCoverage") && replacement.transcriptCoverage) {
    // Browser checkpoints are observations, not proof that the finite Eve
    // transcript was read. Never downgrade a server-authoritative marker.
    if (current.transcriptCoverage?.authoritative === true) next.transcriptCoverage = current.transcriptCoverage;
    else next.transcriptCoverage = replacement.transcriptCoverage;
  } else if (Object.prototype.hasOwnProperty.call(replacement, "transcriptCoverage") && !replacement.transcriptCoverage) {
    if (current.transcriptCoverage) next.transcriptCoverage = current.transcriptCoverage;
    else delete next.transcriptCoverage;
  } else if (current.transcriptCoverage) {
    next.transcriptCoverage = current.transcriptCoverage;
  } else {
    delete next.transcriptCoverage;
  }
  return next as AgentThreadCollection["threads"][number];
}

export function summarizeThreadCollection(
  collection: AgentThreadCollection,
  includedThreadId?: string,
): AgentThreadCollection {
  return {
    ...(collection.activeThreadId ? { activeThreadId: collection.activeThreadId } : {}),
    threads: collection.threads.map((thread) => {
      // The selected thread used to be returned inline to avoid a second
      // request. After event-log migration, however, the metadata row can
      // legitimately contain zero (or a compact prefix of) events while its
      // Eve cursor is far ahead. Mark that thread for hydration too; otherwise
      // the client treats the incomplete inline value as authoritative and
      // never invokes the bounded transcript repair endpoint.
      const selectedThreadNeedsHydration = thread.id === includedThreadId && (
        // `loadIndex` deliberately returns an empty event array. A coverage
        // marker proves the event-log cursor, not that the index response
        // contains the transcript. Keep the selected thread inline only when
        // it actually carries events (or is an untouched empty session).
        thread.session.streamIndex > thread.events.length &&
        (thread.transcriptCoverage?.authoritative !== true || thread.events.length === 0)
      );
      return thread.id === includedThreadId && !selectedThreadNeedsHydration
        ? thread
        : {
          closedInputRequestIds: [],
          createdAt: thread.createdAt,
          events: [],
          hydration: "summary",
          id: thread.id,
          ...(thread.pendingTurn ? { pendingTurn: thread.pendingTurn } : {}),
          preferences: thread.preferences,
          queuedTurns: thread.queuedTurns,
          revision: thread.revision,
          session: thread.session,
          status: thread.status,
          ...(thread.transcriptCoverage ? { transcriptCoverage: thread.transcriptCoverage } : {}),
          title: thread.title,
          updatedAt: thread.updatedAt,
        };
    }),
    version: AGENT_THREAD_STORAGE_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
