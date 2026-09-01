import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResult } from "pg";

import {
  createPostgresThreadCollectionStore,
  normalizeJsonbValue,
  UnsafeThreadTranscriptReplacementError,
  type ThreadCollectionPatchRecord,
} from "../../server/data/thread-collection-store.ts";

const config = {
  connectionString: "postgresql://unused",
  maxPoolSize: 1,
  schema: "open_agent_test",
} as const;

test("saves a thread event containing NUL through the PostgreSQL JSONB boundary", async () => {
  const original = {
    threads: [{
      events: [{
        data: {
          output: {
            content: "binary\u0000payload",
            nested: ["valid", { text: "第二页\u0000完成" }],
          },
        },
        type: "action.result",
      }],
      id: "thread-1",
    }],
    version: 2,
  };
  let persisted: typeof original | undefined;
  const pool = {
    async query(_sql: string, parameters?: readonly unknown[]) {
      const serialized = parameters?.[3];
      assert.equal(typeof serialized, "string");
      assert.doesNotMatch(serialized as string, /\u0000/u);
      persisted = JSON.parse(serialized as string) as typeof original;
      return {
        rows: [{ collection: persisted, revision: "1" }],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore<typeof original>(config, pool);

  const result = await store.save("tenant-1", "principal-1", "workspace-1", 0, original);

  assert.equal(result.status, "saved");
  assert.deepEqual(persisted?.threads[0]?.events[0]?.data.output, {
    content: "binary\uFFFDpayload",
    nested: ["valid", { text: "第二页\uFFFD完成" }],
  });
  assert.equal(original.threads[0]?.events[0]?.data.output.content, "binary\u0000payload");
});

test("normalizes nested JSONB strings without changing normal Unicode or caller data", () => {
  const original = {
    normal: "Muses 设计平台",
    values: ["alpha", "unpaired:\uD800", { content: "before\u0000after" }],
  };

  const normalized = normalizeJsonbValue(original);

  assert.notEqual(normalized, original);
  assert.notEqual(normalized.values, original.values);
  assert.equal(normalized.normal, original.normal);
  assert.equal(normalized.values[0], "alpha");
  assert.equal(normalized.values[1], "unpaired:\uFFFD");
  assert.deepEqual(normalized.values[2], { content: "before\uFFFDafter" });
  assert.equal(original.values[1], "unpaired:\uD800");
  assert.deepEqual(original.values[2], { content: "before\u0000after" });
});

test("full snapshot save replaces transcript inside the collection transaction", async () => {
  const calls: string[] = [];
  const collection = {
    threads: [{
      events: [{
        data: { sequence: 0 },
        meta: { id: "event-1" },
        type: "step.started",
      }],
      id: "thread-1",
      status: "ready",
    }],
    version: 2,
  };
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("set collection = $5::jsonb")) {
        return { rows: [{ collection, revision: "6" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.save("tenant-1", "principal-1", "workspace-1", 5, collection);

  assert.equal(result.status, "saved");
  assert.equal(calls[0], "begin");
  assert.match(calls[1] ?? "", /set collection = \$5::jsonb/u);
  assert.equal(calls.at(-1), "commit");
  assert.equal(calls.filter((sql) => sql.startsWith("delete from")).length, 1);
  assert.equal(calls.filter((sql) => sql.startsWith("insert into")).length, 1);
});

test("append-only thread patches do not load the existing transcript", async () => {
  const calls: string[] = [];
  let updatedCollection: Record<string, unknown> | undefined;
  const client = {
    async query(sql: string, parameters?: readonly unknown[]) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: {
              activeThreadId: "thread-1",
              threads: [{ id: "thread-1", events: [], status: "streaming", title: "Long task" }],
              version: 2,
            },
            revision: "4",
          }],
        };
      }
      if (sql.includes("set collection = $4::jsonb")) {
        updatedCollection = JSON.parse(String(parameters?.[3])) as Record<string, unknown>;
      }
      if (sql.includes("max(event_index)")) return { rows: [{ next_index: "2" }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);
  const patch: ThreadCollectionPatchRecord = {
    deletedThreadIds: [],
    eventAppends: [{
      events: [{ data: { sequence: 2 }, meta: { at: new Date(0).toISOString(), id: "evt-3" }, type: "step.started" }],
      threadId: "thread-1",
    }],
    upsertThreads: [{ events: [], id: "thread-1", status: "streaming", title: "Long task" }],
  };

  const result = await store.patch?.("tenant-1", "principal-1", "workspace-1", 4, patch);

  assert.equal(result?.status, "saved");
  assert.equal(calls.some((sql) => sql.includes("jsonb_array_elements")), false);
  assert.equal(calls.some((sql) => sql.includes("insert into \"open_agent_test\".\"agent_thread_events\"")), true);
  assert.equal(updatedCollection?.activeThreadId, "thread-1");
});

test("a concurrent first patch reports a conflict instead of leaking a unique-key error", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) return { rows: [] };
      if (sql.includes("on conflict") && sql.includes("returning revision::text")) return { rows: [] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
    async query(sql: string) {
      assert.match(sql, /select collection, revision::text/u);
      return { rows: [{ collection: { threads: [], version: 2 }, revision: "1" }] };
    },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.patch?.("tenant-1", "principal-1", "workspace-1", 0, {
    deletedThreadIds: [],
    eventAppends: [],
    upsertThreads: [],
  });

  assert.deepEqual(result, { currentRevision: 1, status: "conflict" });
  assert.equal(calls.filter((sql) => sql === "commit").length, 0);
  assert.equal(calls.filter((sql) => sql === "rollback").length, 1);
  assert.match(calls.find((sql) => sql.includes("on conflict")) ?? "", /do nothing/u);
});

test("append-only thread patches keep event indexes contiguous after replay deduplication", async () => {
  let insertedParameters: readonly unknown[] | undefined;
  const client = {
    async query(sql: string, parameters?: readonly unknown[]) {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: { threads: [{ id: "thread-1", events: [] }], version: 2 },
            revision: "1",
          }],
        };
      }
      if (sql.includes("max(event_index)")) return { rows: [{ next_index: "4" }] };
      if (sql.includes("select event_id")) return { rows: [{ event_id: "evt-duplicate" }] };
      if (sql.includes("insert into") && sql.includes("jsonb_to_recordset")) {
        insertedParameters = parameters;
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.patch?.("tenant-1", "principal-1", "workspace-1", 1, {
    deletedThreadIds: [],
    eventAppends: [{
      events: [
        { type: "duplicate", meta: { id: "evt-duplicate" } },
        { type: "fresh-a", meta: { id: "evt-a" } },
        { type: "fresh-b", meta: { id: "evt-b" } },
      ],
      threadId: "thread-1",
    }],
    upsertThreads: [{ events: [], id: "thread-1", status: "streaming" }],
  });

  assert.equal(result?.status, "saved");
  const records = JSON.parse(String(insertedParameters?.[4])) as Array<{ event_index: number; event_id: string }>;
  assert.deepEqual(records.map((record) => [record.event_index, record.event_id]), [
    [4, "evt-a"],
    [5, "evt-b"],
  ]);
});

test("replacement appends truncate from their cursor without reading the current tail", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: { threads: [{ id: "thread-1", events: [] }], version: 2 },
            revision: "3",
          }],
        };
      }
      if (sql.includes("select event_id")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.patch?.("tenant-1", "principal-1", "workspace-1", 3, {
    deletedThreadIds: [],
    eventAppends: [{
      events: [{ meta: { id: "evt-replacement" }, type: "message.completed" }],
      replaceFrom: 12,
      threadId: "thread-1",
    }],
    upsertThreads: [{ events: [], id: "thread-1", status: "ready" }],
  });

  assert.equal(result?.status, "saved");
  assert.equal(calls.some((sql) => sql.includes("max(event_index)")), false);
  assert.equal(calls.some((sql) => sql.includes("event_index >= $5")), true);
});

test("rejects an edit replacement whose events are not the durable prefix", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string, parameters?: readonly unknown[]) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: { threads: [{ id: "thread-1", events: [] }], version: 2 },
            revision: "8",
          }],
        };
      }
      if (sql.includes("set collection = $4::jsonb")) {
        return { rows: [] };
      }
      if (sql.includes("max(event_index)")) return { rows: [{ total: "4" }] };
      if (sql.includes("event_index <")) {
        return { rows: [{ event_index: "0", event_id: "evt-original" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  await assert.rejects(
    async () => {
      if (!store.patch) throw new Error("patch is unavailable");
      await store.patch("tenant-1", "principal-1", "workspace-1", 8, {
        deletedThreadIds: [],
        eventAppends: [],
        upsertThreads: [{
          events: [{ meta: { id: "evt-tail-only" }, type: "message.completed" }],
          id: "thread-1",
          pendingTurn: { id: "edit-1", state: "clearing", submittedAt: 1, text: "edited" },
          status: "ready",
        }],
      });
    },
    (error: unknown) => error instanceof UnsafeThreadTranscriptReplacementError,
  );
  assert.equal(calls.some((sql) => sql.startsWith("delete from")), false);
  assert.equal(calls.at(-1), "rollback");
});

test("allows an explicit edit to retain a verified event prefix", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string, parameters?: readonly unknown[]) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: { threads: [{ id: "thread-1", events: [] }], version: 2 },
            revision: "8",
          }],
        };
      }
      if (sql.includes("set collection = $4::jsonb")) {
        return { rows: [] };
      }
      if (sql.includes("max(event_index)")) return { rows: [{ total: "2" }] };
      if (sql.includes("event_index <")) {
        return {
          rows: [
            { event_index: "0", event_id: "evt-first" },
            { event_index: "1", event_id: "evt-second" },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.patch?.("tenant-1", "principal-1", "workspace-1", 8, {
    deletedThreadIds: [],
    eventAppends: [],
    upsertThreads: [{
      events: [
        { meta: { id: "evt-first" }, type: "message.received" },
        { meta: { id: "evt-second" }, type: "message.completed" },
      ],
      id: "thread-1",
      pendingTurn: { id: "edit-1", state: "clearing", submittedAt: 1, text: "edited" },
      status: "ready",
    }],
  });

  assert.equal(result?.status, "saved");
  assert.equal(calls.filter((sql) => sql.startsWith("delete from")).length, 1);
  assert.equal(calls.at(-1), "commit");
});

test("rejects an explicit empty edit snapshot when durable history exists", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: { threads: [{ id: "thread-1", events: [] }], version: 2 },
            revision: "9",
          }],
        };
      }
      if (sql.includes("set collection = $4::jsonb")) return { rows: [] };
      if (sql.includes("max(event_index)")) return { rows: [{ total: "6" }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  await assert.rejects(
    async () => await store.patch?.("tenant-1", "principal-1", "workspace-1", 9, {
      deletedThreadIds: [],
      eventAppends: [],
      upsertThreads: [{
        events: [],
        id: "thread-1",
        pendingTurn: { id: "edit-1", state: "resubmitting", submittedAt: 1, text: "edited" },
        status: "ready",
      }],
    }),
    (error: unknown) => error instanceof UnsafeThreadTranscriptReplacementError,
  );
  assert.equal(calls.some((sql) => sql.startsWith("delete from")), false);
  assert.equal(calls.at(-1), "rollback");
});

test("server-owned submitting edits update metadata without replacing the event log", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: { threads: [{ id: "thread-1", events: [] }], version: 2 },
            revision: "10",
          }],
        };
      }
      if (sql.includes("set collection = $4::jsonb")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.patch?.("tenant-1", "principal-1", "workspace-1", 10, {
    deletedThreadIds: [],
    eventAppends: [],
    upsertThreads: [{
      events: [],
      hydration: "summary",
      id: "thread-1",
      pendingTurn: { id: "edit-1", operation: "edit", state: "submitting", submittedAt: 1, text: "edited" },
      status: "submitted",
    }],
  });

  assert.equal(result?.status, "saved");
  assert.equal(calls.some((sql) => sql.includes("max(event_index)")), false);
  assert.equal(calls.at(-1), "commit");
});

test("empty append checkpoints do not query the event log", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("for update")) {
        return {
          rows: [{
            collection: { threads: [{ id: "thread-1", events: [] }], version: 2 },
            revision: "5",
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.patch?.("tenant-1", "principal-1", "workspace-1", 5, {
    deletedThreadIds: [],
    eventAppends: [{ events: [], threadId: "thread-1" }],
    upsertThreads: [{ events: [], id: "thread-1", status: "ready" }],
  });

  assert.equal(result?.status, "saved");
  assert.equal(calls.some((sql) => sql.includes("agent_thread_events")), false);
});

test("legacy thread hydration returns a bounded tail instead of aggregating full history", async () => {
  let loadedSql = "";
  const pool = {
    async query(sql: string) {
      loadedSql = sql;
      return {
        rows: [{
          thread: {
            id: "thread-1",
            events: [{ type: "session.waiting", data: {}, meta: { id: "evt-1" } }],
            status: "ready",
          },
          revision: "9",
          total: "500",
          start_index: "244",
          end_index: "500",
          has_more_before: true,
        }],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.loadThread?.("tenant-1", "principal-1", "workspace-1", "thread-1");

  assert.equal((result?.thread as { readonly id?: unknown } | undefined)?.id, "thread-1");
  assert.match(loadedSql, /with target as/u);
  assert.match(loadedSql, /limit \$6/u);
  assert.doesNotMatch(loadedSql, /jsonb_agg\(entry\.event order by entry\.event_index asc\)/u);
});

test("loads a bounded ordered transcript window without aggregating the full event log", async () => {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes("with target as")) {
        return {
          rows: [{
            thread: { id: "thread-1", events: [{ type: "event-2" }, { type: "event-3" }] },
            revision: "7",
            total: "10",
            start_index: "8",
            end_index: "10",
            has_more_before: true,
          }],
        } as unknown as QueryResult;
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.loadThreadWindow?.(
    "tenant-1",
    "principal-1",
    "workspace-1",
    "thread-1",
    { before: 10, limit: 2 },
  );

  assert.equal(result?.revision, 7);
  assert.deepEqual(result?.window, {
    endIndex: 10,
    hasMoreBefore: true,
    startIndex: 8,
    total: 10,
  });
  assert.deepEqual((result?.thread as { events?: unknown[] }).events, [
    { type: "event-2" },
    { type: "event-3" },
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /limit \$6/u);
  assert.doesNotMatch(calls[0]!, /jsonb_agg\(entry\.event order by entry\.event_index asc\)/u);
});

test("loads the thread index without joining or aggregating event payloads", async () => {
  let loadedSql = "";
  const pool = {
    async query(sql: string) {
      loadedSql = sql;
      return {
        rows: [{ collection: { threads: [], version: 2 }, revision: "11" }],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.loadIndex?.("tenant-1", "principal-1", "workspace-1");

  assert.equal(result?.revision, 11);
  assert.match(loadedSql, /'events', '\[\]'::jsonb/u);
  assert.match(loadedSql, /'pendingTurn', thread->'pendingTurn'/u);
  assert.match(loadedSql, /'queuedTurns', coalesce\(thread->'queuedTurns'/u);
  assert.doesNotMatch(loadedSql, /agent_thread_events/u);
});

test("reads only a collection revision for conditional index requests", async () => {
  let loadedSql = "";
  const pool = {
    async query(sql: string) {
      loadedSql = sql;
      return { rows: [{ revision: "12" }] } as unknown as QueryResult;
    },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const revision = await store.readRevision?.("tenant-1", "principal-1", "workspace-1");

  assert.equal(revision, 12);
  assert.match(loadedSql, /select revision::text/u);
  assert.doesNotMatch(loadedSql, /jsonb_array_elements|jsonb_agg|agent_thread_events/u);
});
