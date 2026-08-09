import type { AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";
import {
  AGENT_THREAD_STORAGE_VERSION,
  parseThreadCollection,
} from "@oworker/open-agent-ui/agent-workspace";

export type ThreadCollectionPatch = {
  readonly activeThreadId: string | null;
  readonly deletedThreadIds: readonly string[];
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
    !Array.isArray(value.upsertThreads)
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
  const touchedIds = [...deletedThreadIds, ...parsed.threads.map((thread) => thread.id)];
  if (new Set(touchedIds).size !== touchedIds.length) return undefined;
  return {
    activeThreadId: value.activeThreadId,
    deletedThreadIds,
    upsertThreads: parsed.threads,
  };
}

export function applyThreadCollectionPatch(
  current: AgentThreadCollection,
  patch: ThreadCollectionPatch,
): AgentThreadCollection {
  const deleted = new Set(patch.deletedThreadIds);
  const replacements = new Map(patch.upsertThreads.map((thread) => [thread.id, thread]));
  const threads = current.threads
    .filter((thread) => !deleted.has(thread.id))
    .map((thread) => {
      const replacement = replacements.get(thread.id);
      if (!replacement) return thread;
      if (replacement.hydration !== "summary") return replacement;
      return {
        ...thread,
        preferences: replacement.preferences,
        revision: replacement.revision,
        session: replacement.session,
        status: replacement.status,
        title: replacement.title,
        updatedAt: replacement.updatedAt,
      };
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

export function summarizeThreadCollection(
  collection: AgentThreadCollection,
  includedThreadId?: string,
): AgentThreadCollection {
  return {
    ...(collection.activeThreadId ? { activeThreadId: collection.activeThreadId } : {}),
    threads: collection.threads.map((thread) => thread.id === includedThreadId
      ? thread
      : {
          closedInputRequestIds: [],
          createdAt: thread.createdAt,
          events: [],
          hydration: "summary",
          id: thread.id,
          preferences: thread.preferences,
          queuedTurns: [],
          revision: thread.revision,
          session: thread.session,
          status: thread.status,
          title: thread.title,
          updatedAt: thread.updatedAt,
        }),
    version: AGENT_THREAD_STORAGE_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
