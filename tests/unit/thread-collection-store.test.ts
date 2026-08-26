import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResult } from "pg";

import {
  createPostgresThreadCollectionStore,
  normalizeJsonbValue,
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

test("hydrating one thread removes the index-only summary marker", async () => {
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
        }],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;
  const store = createPostgresThreadCollectionStore(config, pool);

  const result = await store.loadThread?.("tenant-1", "principal-1", "workspace-1", "thread-1");

  assert.equal((result?.thread as { readonly id?: unknown } | undefined)?.id, "thread-1");
  assert.equal(loadedSql.includes("thread - 'events' - 'hydration'"), true);
  assert.equal(loadedSql.includes("jsonb_build_object(\n            'events'"), true);
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
});
