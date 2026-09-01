import type { Pool, PoolClient } from "pg";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";

export type StoredThreadCollection<TCollection> = {
  readonly collection: TCollection;
  readonly revision: number;
};

export type StoredThread<TThread = unknown> = {
  readonly thread: TThread;
  readonly revision: number;
};

/** A bounded, ordered slice of the append-only transcript. Indexes are
 * collection-event indexes (zero-based, end exclusive), not an arbitrary
 * retention limit and not the Eve runtime cursor. */
export type StoredThreadWindow<TThread = unknown> = StoredThread<TThread> & {
  readonly window: {
    readonly endIndex: number;
    readonly hasMoreBefore: boolean;
    readonly startIndex: number;
    readonly total: number;
  };
};

export type ThreadCollectionWriteResult<TCollection> =
  | { readonly record: StoredThreadCollection<TCollection>; readonly status: "saved" }
  | { readonly currentRevision: number; readonly status: "conflict" };

/**
 * Raised when a client attempts to replace an existing transcript with a
 * snapshot that cannot be proven to be the durable prefix. Callers should
 * surface this as a retryable client error; the existing event log is left
 * untouched.
 */
export class UnsafeThreadTranscriptReplacementError extends Error {
  constructor(message = "The thread transcript is incomplete; reload it before editing.") {
    super(message);
    this.name = "UnsafeThreadTranscriptReplacementError";
  }
}

/** The transport-neutral shape used by the HTTP thread PATCH contract. */
export type ThreadCollectionPatchRecord = {
  /** Undefined preserves the stored selection; null explicitly clears it. */
  readonly activeThreadId?: string | null;
  readonly deletedThreadIds: readonly string[];
  readonly eventAppends: readonly {
    readonly events: readonly unknown[];
    readonly replaceFrom?: number;
    readonly threadId: string;
  }[];
  readonly upsertThreads: readonly Record<string, unknown>[];
};

export interface AgentThreadCollectionStore<TCollection = unknown> {
  load(
    tenantId: string,
    principalId: string,
    storageKey: string,
  ): Promise<StoredThreadCollection<TCollection> | undefined>;
  /** Reads only the collection revision. Used to answer conditional GETs
   * without materializing the thread index when the caller is already current. */
  readRevision?(
    tenantId: string,
    principalId: string,
    storageKey: string,
  ): Promise<number | undefined>;
  /** Reads only thread metadata for the sidebar; event payloads stay in Postgres. */
  loadIndex?(
    tenantId: string,
    principalId: string,
    storageKey: string,
  ): Promise<StoredThreadCollection<TCollection> | undefined>;
  /** Reads one bounded tail window for legacy callers. Older pages are loaded
   * through loadThreadWindow; this method must never aggregate an unbounded
   * event log into one JSON response. The returned thread carries its
   * transcriptWindow marker when more history exists. */
  loadThread?(
    tenantId: string,
    principalId: string,
    storageKey: string,
    threadId: string,
  ): Promise<StoredThread | undefined>;
  /** Reads one bounded transcript window without materializing older events. */
  loadThreadWindow?(
    tenantId: string,
    principalId: string,
    storageKey: string,
    threadId: string,
    options?: { readonly before?: number; readonly limit?: number },
  ): Promise<StoredThreadWindow | undefined>;
  /** Applies normal append-only stream checkpoints without loading history. */
  patch?(
    tenantId: string,
    principalId: string,
    storageKey: string,
    expectedRevision: number,
    patch: ThreadCollectionPatchRecord,
  ): Promise<ThreadCollectionWriteResult<TCollection>>;
  save(
    tenantId: string,
    principalId: string,
    storageKey: string,
    expectedRevision: number,
    collection: TCollection,
  ): Promise<ThreadCollectionWriteResult<TCollection>>;
}

export function createPostgresThreadCollectionStore<TCollection = unknown>(
  config: AgentDatabaseConfig,
  pool: Pool = getAgentDatabasePool(config),
): AgentThreadCollectionStore<TCollection> {
  const table = `${quoteIdentifier(config.schema)}."agent_thread_collections"`;
  const eventTable = `${quoteIdentifier(config.schema)}."agent_thread_events"`;
  return postgresThreadCollectionStore<TCollection>(pool, table, eventTable);
}

export function createPostgresThreadCollectionStoreFromEnvironment<TCollection = unknown>(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentThreadCollectionStore<TCollection> | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresThreadCollectionStore<TCollection>(config) : undefined;
}

function postgresThreadCollectionStore<TCollection>(
  pool: Pool,
  table: string,
  eventTable: string,
): AgentThreadCollectionStore<TCollection> {
  const load = async (
    tenantId: string,
    principalId: string,
    storageKey: string,
  ): Promise<StoredThreadCollection<TCollection> | undefined> => {
    assertScope(tenantId, principalId, storageKey);
    const result = await pool.query<{ collection: TCollection; revision: string }>(
      `select collection, revision::text
         from ${table}
        where tenant_id = $1 and principal_id = $2 and storage_key = $3`,
      [tenantId, principalId, storageKey],
    );
    const row = result.rows[0];
    return row
      ? { collection: row.collection, revision: parseRevision(row.revision) }
      : undefined;
  };

  const loadIndex = async (
    tenantId: string,
    principalId: string,
    storageKey: string,
  ): Promise<StoredThreadCollection<TCollection> | undefined> => {
    assertScope(tenantId, principalId, storageKey);
    const result = await pool.query<{ collection: TCollection; revision: string }>(
      `select jsonb_build_object(
                'activeThreadId', collection->'activeThreadId',
                'threads', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'closedInputRequestIds', '[]'::jsonb,
                    'createdAt', thread->'createdAt',
                    'events', '[]'::jsonb,
                    'hydration', 'summary',
                    'id', thread->'id',
                    'pendingTurn', thread->'pendingTurn',
                    'preferences', thread->'preferences',
                    'queuedTurns', coalesce(thread->'queuedTurns', '[]'::jsonb),
                    'revision', thread->'revision',
                    'session', thread->'session',
                    'status', thread->'status',
                    'transcriptCoverage', thread->'transcriptCoverage',
                    'title', thread->'title',
                    'updatedAt', thread->'updatedAt'
                  ) order by coalesce((thread->>'updatedAt')::double precision, 0) desc)
                  from jsonb_array_elements(coalesce(collection->'threads', '[]'::jsonb)) as thread
                ), '[]'::jsonb),
                'version', coalesce(collection->'version', '2'::jsonb)
              ) as collection,
              revision::text
         from ${table}
        where tenant_id = $1 and principal_id = $2 and storage_key = $3`,
      [tenantId, principalId, storageKey],
    );
    const row = result.rows[0];
    return row
      ? { collection: row.collection, revision: parseRevision(row.revision) }
      : undefined;
  };

  const loadThread = async (
    tenantId: string,
    principalId: string,
    storageKey: string,
    threadId: string,
  ): Promise<StoredThread | undefined> => {
    const bounded = await loadThreadWindow(tenantId, principalId, storageKey, threadId, { limit: 256 });
    return bounded
      ? {
          revision: bounded.revision,
          thread: isRecordValue(bounded.thread)
            ? { ...bounded.thread, transcriptWindow: bounded.window }
            : bounded.thread,
        }
      : undefined;
  };

  const loadThreadWindow = async (
    tenantId: string,
    principalId: string,
    storageKey: string,
    threadId: string,
    options: { readonly before?: number; readonly limit?: number } = {},
  ): Promise<StoredThreadWindow | undefined> => {
    assertScope(tenantId, principalId, storageKey);
    assertText(threadId, "threadId", 200);
    const limit = boundedWindowInteger(options.limit, 256, 1, 1_000, "limit");
    const before = options.before === undefined
      ? undefined
      : boundedWindowInteger(options.before, 0, 0, Number.MAX_SAFE_INTEGER, "before");
    // The bounds are computed in the same SQL snapshot as the selected rows.
    // This keeps pagination monotonic when a live turn appends events between
    // requests and avoids jsonb_agg over the whole transcript.
    const result = await pool.query<{
      end_index: string;
      has_more_before: boolean;
      revision: string;
      start_index: string;
      thread: unknown;
      total: string;
    }>(
      `with target as (
       select
           (thread - 'events' - 'hydration' - 'transcriptWindow') as metadata,
           thread->'events' as legacy_events,
           collection_row.revision::text as revision
           from ${table} collection_row,
                lateral jsonb_array_elements(coalesce(collection_row.collection->'threads', '[]'::jsonb)) as thread
          where collection_row.tenant_id = $1
            and collection_row.principal_id = $2
            and collection_row.storage_key = $3
            and thread->>'id' = $4
          limit 1
       ), counts as (
         select coalesce((
           select max(event_index) + 1
             from ${eventTable}
            where tenant_id = $1 and principal_id = $2 and storage_key = $3 and thread_id = $4
         ), jsonb_array_length(coalesce(target.legacy_events, '[]'::jsonb)), 0)::text as total
           from target
       ), bounds as (
         select
           total,
           least(total::bigint, coalesce($5::bigint, total::bigint)) as end_index,
           greatest(0::bigint, least(total::bigint, coalesce($5::bigint, total::bigint)) - $6::bigint) as start_index
           from counts
       )
       select
         target.metadata || jsonb_build_object(
           'events', coalesce((
             select jsonb_agg(windowed.event order by windowed.event_index asc)
               from (
                 select entry.event_index, entry.event
                   from ${eventTable} entry, bounds
                  where entry.tenant_id = $1
                    and entry.principal_id = $2
                    and entry.storage_key = $3
                    and entry.thread_id = $4
                    and entry.event_index >= bounds.start_index
                    and entry.event_index < bounds.end_index
                  order by entry.event_index asc
                  limit $6
               ) as windowed
           ), coalesce((
             select jsonb_agg(legacy.value order by legacy.ordinality)
               from target, bounds,
                    jsonb_array_elements(coalesce(target.legacy_events, '[]'::jsonb)) with ordinality as legacy(value, ordinality)
              where legacy.ordinality > bounds.start_index
                and legacy.ordinality <= bounds.end_index
           ), '[]'::jsonb))
         ) as thread,
         target.revision,
         bounds.total,
         bounds.start_index,
         bounds.end_index,
         (bounds.start_index > 0) as has_more_before
         from target cross join bounds`,
      [tenantId, principalId, storageKey, threadId, before ?? null, limit],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const total = parseRevision(row.total);
    const startIndex = parseRevision(row.start_index);
    const endIndex = parseRevision(row.end_index);
    return {
      thread: row.thread,
      revision: parseRevision(row.revision),
      window: { endIndex, hasMoreBefore: row.has_more_before === true, startIndex, total },
    };
  };

  return {
    load,
    async readRevision(tenantId, principalId, storageKey) {
      assertScope(tenantId, principalId, storageKey);
      const result = await pool.query<{ revision: string }>(
        `select revision::text
           from ${table}
          where tenant_id = $1 and principal_id = $2 and storage_key = $3`,
        [tenantId, principalId, storageKey],
      );
      const row = result.rows[0];
      return row ? parseRevision(row.revision) : undefined;
    },
    loadIndex,
    loadThread,
    loadThreadWindow,
    async patch(tenantId, principalId, storageKey, expectedRevision, input) {
      assertScope(tenantId, principalId, storageKey);
      assertRevision(expectedRevision);
      assertThreadPatch(input);

      const connection = await pool.connect();
      try {
        await connection.query("begin");
        const locked = await connection.query<{ collection: Record<string, unknown>; revision: string }>(
          `select collection, revision::text
             from ${table}
            where tenant_id = $1 and principal_id = $2 and storage_key = $3
            for update`,
          [tenantId, principalId, storageKey],
        );
        const row = locked.rows[0];
        if (expectedRevision !== (row ? parseRevision(row.revision) : 0)) {
          await connection.query("rollback");
          return {
            currentRevision: row ? parseRevision(row.revision) : 0,
            status: "conflict",
          };
        }

        const current = isRecordValue(row?.collection)
          ? row.collection
          : { threads: [], version: 2 };
        const currentThreads = Array.isArray(current.threads)
          ? current.threads.filter(isRecordValue)
          : [];
        const currentById = new Map(
          currentThreads.flatMap((thread) => typeof thread.id === "string" ? [[thread.id, thread] as const] : []),
        );
        const deleted = new Set(input.deletedThreadIds);
        const replacements = new Map(input.upsertThreads.flatMap((thread) =>
          typeof thread.id === "string" ? [[thread.id, thread] as const] : []));
        const nextThreads: Record<string, unknown>[] = [];
        for (const existing of currentThreads) {
          const id = typeof existing.id === "string" ? existing.id : undefined;
          if (!id || deleted.has(id)) continue;
          const replacement = replacements.get(id);
          const next = replacement
            ? replacement.hydration === "summary"
              ? mergeSummaryThread(existing, replacement)
              : replacement
            : existing;
          nextThreads.push({ ...next, events: [] });
        }
        for (const [id, replacement] of replacements) {
          if (!currentById.has(id) && !deleted.has(id)) nextThreads.push({ ...replacement, events: [] });
        }
        const requestedActiveThreadId = input.activeThreadId === undefined
          ? typeof current.activeThreadId === "string" ? current.activeThreadId : undefined
          : input.activeThreadId ?? undefined;
        const nextCollection = normalizeJsonbValue({
          ...(requestedActiveThreadId ? { activeThreadId: requestedActiveThreadId } : {}),
          threads: nextThreads,
          version: 2,
        });
        const serialized = JSON.stringify(nextCollection);
        if (serialized === undefined) throw new Error("Thread patch must be JSON serializable.");

        if (!row) {
          const inserted = await connection.query(
            `insert into ${table}
              (tenant_id, principal_id, storage_key, revision, collection)
             values ($1, $2, $3, 1, $4::jsonb)
             on conflict (tenant_id, principal_id, storage_key) do nothing
             returning revision::text`,
            [tenantId, principalId, storageKey, serialized],
          );
          if (inserted.rows.length === 0) {
            await connection.query("rollback");
            const current = await load(tenantId, principalId, storageKey);
            return { currentRevision: current?.revision ?? 0, status: "conflict" };
          }
        } else {
          await connection.query(
            `update ${table}
                set collection = $4::jsonb,
                    revision = revision + 1,
                    updated_at = now()
              where tenant_id = $1 and principal_id = $2 and storage_key = $3`,
            [tenantId, principalId, storageKey, serialized],
          );
        }

        for (const threadId of input.deletedThreadIds) {
          await connection.query(
            `delete from ${eventTable}
              where tenant_id = $1 and principal_id = $2 and storage_key = $3 and thread_id = $4`,
            [tenantId, principalId, storageKey, threadId],
          );
        }

        // A full event array is only sent for a new or edited thread. Normal
        // streaming checkpoints use eventAppends and never copy old history.
        for (const thread of input.upsertThreads) {
          if (typeof thread.id !== "string") continue;
          const events = threadEvents(thread);
          if (events.length === 0 && !isExplicitTranscriptReplacement(thread)) continue;
          await replaceThreadEvents(
            connection,
            eventTable,
            tenantId,
            principalId,
            storageKey,
            thread.id,
            events,
          );
        }
        for (const append of input.eventAppends) {
          await appendThreadEvents(connection, eventTable, tenantId, principalId, storageKey, append);
        }

        await connection.query("commit");
        return {
          record: { collection: nextCollection as TCollection, revision: expectedRevision + 1 },
          status: "saved",
        };
      } catch (error) {
        await connection.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    async save(tenantId, principalId, storageKey, expectedRevision, collection) {
      assertScope(tenantId, principalId, storageKey);
      assertRevision(expectedRevision);
      const normalized = normalizeJsonbValue(collection);
      const serialized = JSON.stringify(normalized);
      if (serialized === undefined) throw new Error("Thread collection must be JSON serializable.");

      // Full snapshots are used for edits and legacy callers. Keep the
      // collection revision update and any transcript replacement in one
      // transaction; otherwise a concurrent append-only checkpoint can commit
      // between these operations and then be deleted by replaceThreadEvents.
      // Test/fallback pools without connect() retain the original single-query
      // behavior below.
      if (typeof (pool as Pool & { connect?: unknown }).connect === "function") {
        const connection = await pool.connect();
        try {
          await connection.query("begin");
          const result = expectedRevision === 0
            ? await connection.query<{ collection: TCollection; revision: string }>(
                `insert into ${table}
                  (tenant_id, principal_id, storage_key, revision, collection)
                 values ($1, $2, $3, 1, $4::jsonb)
                 on conflict (tenant_id, principal_id, storage_key) do nothing
                 returning collection, revision::text`,
                [tenantId, principalId, storageKey, serialized],
              )
            : await connection.query<{ collection: TCollection; revision: string }>(
                `update ${table}
                    set collection = $5::jsonb,
                        revision = revision + 1,
                        updated_at = now()
                  where tenant_id = $1 and principal_id = $2 and storage_key = $3
                    and revision = $4
                 returning collection, revision::text`,
                [tenantId, principalId, storageKey, expectedRevision, serialized],
              );

          const saved = result.rows[0];
          if (!saved) {
            await connection.query("rollback");
            const current = await load(tenantId, principalId, storageKey);
            return { currentRevision: current?.revision ?? 0, status: "conflict" };
          }

          const persistedThreads = isRecordValue(normalized) && Array.isArray(normalized.threads)
            ? normalized.threads.filter(isRecordValue)
            : [];
          for (const thread of persistedThreads) {
            const events = threadEvents(thread);
            if (typeof thread.id === "string" &&
                (events.length > 0 || isExplicitTranscriptReplacement(thread))) {
              await replaceThreadEvents(
                connection,
                eventTable,
                tenantId,
                principalId,
                storageKey,
                thread.id,
                events,
              );
            }
          }
          await connection.query("commit");
          return {
            record: { collection: saved.collection, revision: parseRevision(saved.revision) },
            status: "saved",
          };
        } catch (error) {
          await connection.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          connection.release();
        }
      }

      const result = expectedRevision === 0
        ? await pool.query<{ collection: TCollection; revision: string }>(
            `insert into ${table}
              (tenant_id, principal_id, storage_key, revision, collection)
             values ($1, $2, $3, 1, $4::jsonb)
             on conflict (tenant_id, principal_id, storage_key) do nothing
             returning collection, revision::text`,
            [tenantId, principalId, storageKey, serialized],
          )
        : await pool.query<{ collection: TCollection; revision: string }>(
            `update ${table}
                set collection = $5::jsonb,
                    revision = revision + 1,
                    updated_at = now()
              where tenant_id = $1 and principal_id = $2 and storage_key = $3
                and revision = $4
             returning collection, revision::text`,
            [tenantId, principalId, storageKey, expectedRevision, serialized],
          );

      const saved = result.rows[0];
      if (saved) {
        const persistedThreads = isRecordValue(normalized) && Array.isArray(normalized.threads)
          ? normalized.threads.filter(isRecordValue)
          : [];
        // Full snapshots are reserved for edits/legacy callers. Keep the
        // append-only log authoritative for any thread that carries an
        // explicit transcript; summary-only metadata saves leave its history
        // untouched.
        if (typeof (pool as Pool & { connect?: unknown }).connect === "function") {
          for (const thread of persistedThreads) {
            const events = threadEvents(thread);
            if (typeof thread.id === "string" &&
                (events.length > 0 || isExplicitTranscriptReplacement(thread))) {
              await replaceThreadEvents(
                pool,
                eventTable,
                tenantId,
                principalId,
                storageKey,
                thread.id,
                events,
              );
            }
          }
        }
        return {
          record: { collection: saved.collection, revision: parseRevision(saved.revision) },
          status: "saved",
        };
      }

      const current = await load(tenantId, principalId, storageKey);
      return { currentRevision: current?.revision ?? 0, status: "conflict" };
    },
  };
}

export function normalizeJsonbValue<T>(value: T): T {
  if (typeof value === "string") {
    return value.toWellFormed().replaceAll("\u0000", "\uFFFD") as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonbValue(entry)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeJsonbValue(entry)]),
    ) as T;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertScope(tenantId: string, principalId: string, storageKey: string): void {
  assertText(tenantId, "tenantId", 512);
  assertText(principalId, "principalId", 512);
  assertText(storageKey, "storageKey", 200);
}

function assertText(value: string, name: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer.");
  }
}

function parseRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Stored thread collection revision exceeds the supported range.");
  }
  return revision;
}

function boundedWindowInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return candidate;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ThreadEventQueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

function assertThreadPatch(input: ThreadCollectionPatchRecord): void {
  if (!isRecordValue(input) || !Array.isArray(input.deletedThreadIds) ||
      !Array.isArray(input.eventAppends) || !Array.isArray(input.upsertThreads)) {
    throw new Error("Invalid thread collection patch.");
  }
  if (
    input.activeThreadId !== undefined && input.activeThreadId !== null &&
    (typeof input.activeThreadId !== "string" || !input.activeThreadId.trim() || input.activeThreadId.length > 200)
  ) {
    throw new Error("Invalid active thread id.");
  }
}

function threadEvents(thread: Record<string, unknown>): readonly Record<string, unknown>[] {
  return Array.isArray(thread.events) ? thread.events.filter(isRecordValue) : [];
}

function isExplicitTranscriptReplacement(thread: Record<string, unknown>): boolean {
  const pending = isRecordValue(thread.pendingTurn) ? thread.pendingTurn : undefined;
  if (!pending) return false;
  return pending.state === "clearing" ||
    pending.state === "resubmitting" ||
    (pending.state === "submitting" && pending.operation === "edit");
}

/** Keep summary metadata authoritative, including explicit clearing of
 * optional browser transaction state such as pendingTurn. */
function mergeSummaryThread(
  current: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> {
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
  const replacementCoverage = isRecordValue(replacement.transcriptCoverage)
    ? replacement.transcriptCoverage
    : undefined;
  const currentCoverage = isRecordValue(current.transcriptCoverage)
    ? current.transcriptCoverage
    : undefined;
  const replacingEditedTurn = isRecordValue(replacement.pendingTurn) &&
    (replacement.pendingTurn.state === "clearing" || replacement.pendingTurn.state === "resubmitting");
  if (replacingEditedTurn) {
    delete next.transcriptCoverage;
  } else if (replacementCoverage?.authoritative === true) {
    next.transcriptCoverage = replacementCoverage;
  } else if (Object.prototype.hasOwnProperty.call(replacement, "transcriptCoverage") && replacementCoverage) {
    if (currentCoverage?.authoritative === true) {
      next.transcriptCoverage = currentCoverage;
    } else {
      next.transcriptCoverage = replacementCoverage;
    }
  } else if (Object.prototype.hasOwnProperty.call(replacement, "transcriptCoverage") && !replacement.transcriptCoverage) {
    if (currentCoverage) next.transcriptCoverage = currentCoverage;
    else delete next.transcriptCoverage;
  } else if (currentCoverage) {
    next.transcriptCoverage = currentCoverage;
  } else {
    delete next.transcriptCoverage;
  }
  return next;
}

async function replaceThreadEvents(
  connection: ThreadEventQueryExecutor,
  eventTable: string,
  tenantId: string,
  principalId: string,
  storageKey: string,
  threadId: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  await assertReplacementPrefix(
    connection,
    eventTable,
    tenantId,
    principalId,
    storageKey,
    threadId,
    events,
  );
  await connection.query(
    `delete from ${eventTable}
      where tenant_id = $1 and principal_id = $2 and storage_key = $3 and thread_id = $4`,
    [tenantId, principalId, storageKey, threadId],
  );
  await insertThreadEvents(connection, eventTable, tenantId, principalId, storageKey, threadId,
    events.map((event, index) => ({ event, eventIndex: index })));
}

/**
 * Validate an edit snapshot against the currently locked durable event log
 * before deleting anything. Stable Eve event ids let us prove that the
 * submitted events are the exact prefix the edit intends to retain. A stale
 * bounded tail (or reordered snapshot) therefore fails closed instead of
 * truncating earlier turns.
 */
async function assertReplacementPrefix(
  connection: ThreadEventQueryExecutor,
  eventTable: string,
  tenantId: string,
  principalId: string,
  storageKey: string,
  threadId: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  const countResult = await connection.query<{ total: string }>(
    `select coalesce(max(event_index) + 1, 0)::text as total
       from ${eventTable}
      where tenant_id = $1 and principal_id = $2 and storage_key = $3 and thread_id = $4`,
    [tenantId, principalId, storageKey, threadId],
  );
  const total = parseRevision(countResult.rows[0]?.total ?? "0");
  if (total === 0) return;
  if (events.length === 0) {
    // An edit must always prove the retained prefix. An empty snapshot cannot
    // prove that the browser saw the earlier turns, even when the edit marker
    // is present; accepting it would delete durable history on a stale or
    // partially hydrated client. A genuinely new thread has total === 0 and
    // remains valid above.
    throw new UnsafeThreadTranscriptReplacementError();
  }
  if (events.length > total) throw new UnsafeThreadTranscriptReplacementError();

  const prefixResult = await connection.query<{ event_id: string; event_index: string }>(
    `select event_index::text, event_id
       from ${eventTable}
      where tenant_id = $1 and principal_id = $2 and storage_key = $3
        and thread_id = $4 and event_index < $5
      order by event_index asc`,
    [tenantId, principalId, storageKey, threadId, events.length],
  );
  if (prefixResult.rows.length !== events.length) {
    throw new UnsafeThreadTranscriptReplacementError();
  }
  for (let index = 0; index < events.length; index += 1) {
    const rawMeta = events[index]?.meta;
    // Migrations used `legacy:<index>` for events that predated Eve event
    // ids, while newer append checkpoints include the thread id in their
    // fallback key. Accept either deterministic legacy form; neither can
    // match a different event at the same absolute index.
    const eventId = isRecordValue(rawMeta) && typeof rawMeta.id === "string"
      ? rawMeta.id
      : undefined;
    const stored = prefixResult.rows[index];
    const legacyIds = eventId
      ? []
      : [`legacy:${index}`, `legacy:${threadId}:${index}`];
    if (!stored || parseRevision(stored.event_index) !== index ||
      (!eventId && !legacyIds.includes(stored.event_id)) ||
      (eventId && stored.event_id !== eventId)) {
      throw new UnsafeThreadTranscriptReplacementError();
    }
  }
}

async function appendThreadEvents(
  connection: ThreadEventQueryExecutor,
  eventTable: string,
  tenantId: string,
  principalId: string,
  storageKey: string,
  append: ThreadCollectionPatchRecord["eventAppends"][number],
): Promise<void> {
  const replaceFrom = append.replaceFrom;
  const validEvents = append.events.filter(isRecordValue);
  if (validEvents.length === 0 && replaceFrom === undefined) return;

  let nextIndex = replaceFrom;
  if (nextIndex === undefined) {
    const countResult = await connection.query<{ next_index: string }>(
      `select coalesce(max(event_index) + 1, 0)::text as next_index
         from ${eventTable}
        where tenant_id = $1 and principal_id = $2 and storage_key = $3 and thread_id = $4`,
      [tenantId, principalId, storageKey, append.threadId],
    );
    nextIndex = parseRevision(countResult.rows[0]?.next_index ?? "0");
  }
  if (replaceFrom !== undefined) {
    await connection.query(
      `delete from ${eventTable}
        where tenant_id = $1 and principal_id = $2 and storage_key = $3 and thread_id = $4 and event_index >= $5`,
      [tenantId, principalId, storageKey, append.threadId, replaceFrom],
    );
  }
  const candidates = validEvents.map((rawEvent, offset) => {
    const meta = isRecordValue(rawEvent.meta) ? rawEvent.meta : {};
    const eventId = typeof meta.id === "string" && meta.id
      ? meta.id
      : `legacy:${append.threadId}:${nextIndex + offset}`;
    return { event: rawEvent, eventId };
  });
  if (candidates.length === 0) return;

  // Reconnects can resend a suffix that is already durable. Filter those
  // identities before assigning indexes; relying on INSERT ... ON CONFLICT
  // alone would leave holes when an early duplicate causes a later event to
  // retain its old offset. A contiguous event log is required by absolute
  // transcript pagination and recovery cursors.
  const existing = await connection.query<{ event_id: string }>(
    `select event_id
       from ${eventTable}
      where tenant_id = $1 and principal_id = $2 and storage_key = $3
        and thread_id = $4 and event_id = any($5::text[])`,
    [tenantId, principalId, storageKey, append.threadId, candidates.map((candidate) => candidate.eventId)],
  );
  const existingIds = new Set(existing.rows.map((row) => row.event_id));
  const seenIds = new Set<string>();
  const fresh = candidates.filter((candidate) => {
    if (existingIds.has(candidate.eventId) || seenIds.has(candidate.eventId)) return false;
    seenIds.add(candidate.eventId);
    return true;
  });
  if (fresh.length === 0) return;
  await insertThreadEvents(
    connection,
    eventTable,
    tenantId,
    principalId,
    storageKey,
    append.threadId,
    fresh.map(({ event }, offset) => ({ event, eventIndex: nextIndex + offset })),
  );
}

async function insertThreadEvents(
  connection: ThreadEventQueryExecutor,
  eventTable: string,
  tenantId: string,
  principalId: string,
  storageKey: string,
  threadId: string,
  entries: readonly { readonly event: Record<string, unknown>; readonly eventIndex: number }[],
): Promise<void> {
  if (entries.length === 0) return;
  const records = entries.map(({ event, eventIndex }) => {
    const meta = isRecordValue(event.meta) ? event.meta : {};
    const eventId = typeof meta.id === "string" && meta.id
      ? meta.id
      : `legacy:${threadId}:${eventIndex}`;
    return {
      event: normalizeJsonbValue(event),
      eventId,
      eventIndex,
    };
  });
  await connection.query(
    `insert into ${eventTable}
      (tenant_id, principal_id, storage_key, thread_id, event_index, event_id, event)
     select $1, $2, $3, $4, item.event_index, item.event_id, item.event
       from jsonb_to_recordset($5::jsonb) as item(event_index bigint, event_id text, event jsonb)
      where not exists (
        select 1
          from ${eventTable} existing
         where existing.tenant_id = $1
           and existing.principal_id = $2
           and existing.storage_key = $3
           and existing.thread_id = $4
           and existing.event_id = item.event_id
      )
     on conflict do nothing`,
    [tenantId, principalId, storageKey, threadId, JSON.stringify(records.map((record) => ({
      event: record.event,
      event_id: record.eventId,
      event_index: record.eventIndex,
    })))],
  );
}
