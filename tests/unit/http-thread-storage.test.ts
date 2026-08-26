import assert from "node:assert/strict";
import test from "node:test";

import type { MessageStreamEvent } from "eve/client";
import {
  AgentThreadStorageConflictError,
  createHttpAgentThreadStorage,
} from "@oworker/open-agent-ui/agent-workspace";
import {
  AGENT_THREAD_STORAGE_VERSION,
  createAgentThread,
  type AgentThreadCollection,
} from "@oworker/open-agent-ui/agent-workspace";

test("persists a loaded collection and advances its optimistic revision", async () => {
  const server = fakeThreadServer();
  const storage = createHttpAgentThreadStorage({
    fetch: server.fetch,
    getAccessToken: () => "test-token",
  });

  const initial = await storage.load("workspace-1");
  assert.equal(initial.threads.length, 0);

  const thread = createAgentThread(100, "Persist me");
  await storage.save("workspace-1", {
    activeThreadId: thread.id,
    threads: [thread],
    version: AGENT_THREAD_STORAGE_VERSION,
  });

  assert.equal(server.revision(), 1);
  assert.equal(server.collection().threads[0]?.title, "Persist me");
});

test("an in-flight save snapshots its event baseline before the live buffer grows", async () => {
  type PatchBody = {
    readonly eventAppends?: readonly {
      readonly events: readonly MessageStreamEvent[];
      readonly threadId: string;
    }[];
    readonly upsertThreads?: readonly { readonly events: readonly MessageStreamEvent[] }[];
  };
  const patches: PatchBody[] = [];
  let releaseFirstSave: (() => void) | undefined;
  let markFirstSaveStarted: (() => void) | undefined;
  const firstSaveStarted = new Promise<void>((resolve) => {
    markFirstSaveStarted = resolve;
  });
  const firstSaveMayFinish = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  let revision = 0;
  const storage = createHttpAgentThreadStorage({
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        return Response.json({
          collection: { threads: [], version: AGENT_THREAD_STORAGE_VERSION },
          revision,
        }, { headers: { etag: `"${revision}"` } });
      }
      patches.push(JSON.parse(String(init.body)) as PatchBody);
      if (patches.length === 1) {
        markFirstSaveStarted?.();
        await firstSaveMayFinish;
      }
      revision += 1;
      return Response.json({ revision }, { headers: { etag: `"${revision}"` } });
    }) as typeof fetch,
  });

  await storage.load("workspace-live-buffer");
  const events: MessageStreamEvent[] = [];
  const thread = { ...createAgentThread(100, "Live buffer"), events };
  const collection = {
    activeThreadId: thread.id,
    threads: [thread],
    version: AGENT_THREAD_STORAGE_VERSION,
  };

  const firstSave = storage.save("workspace-live-buffer", collection);
  await firstSaveStarted;
  events.push({
    data: { sequence: 0, stepIndex: 0, turnId: "turn-live" },
    meta: { at: new Date(0).toISOString() },
    type: "step.started",
  } as MessageStreamEvent);
  releaseFirstSave?.();
  await firstSave;
  await storage.save("workspace-live-buffer", collection);

  assert.deepEqual(patches[0]?.upsertThreads?.[0]?.events, []);
  assert.equal(patches[1]?.eventAppends?.[0]?.events.length, 1);
  assert.equal(patches[1]?.eventAppends?.[0]?.events[0]?.type, "step.started");
});

test("surfaces a conflict instead of overwriting another client", async () => {
  const server = fakeThreadServer();
  const first = createHttpAgentThreadStorage({ fetch: server.fetch, getAccessToken: () => "one" });
  const second = createHttpAgentThreadStorage({ fetch: server.fetch, getAccessToken: () => "two" });
  const firstCollection = await first.load("workspace-1");
  const secondCollection = await second.load("workspace-1");

  await first.save("workspace-1", firstCollection);
  await assert.rejects(
    async () => await second.save("workspace-1", secondCollection),
    (error: unknown) =>
      error instanceof AgentThreadStorageConflictError &&
      error.expectedRevision === 0 &&
      error.currentRevision === 1,
  );
});

test("supports same-origin cookie authentication without an authorization header", async () => {
  let authorization: string | null = "unexpected";
  const storage = createHttpAgentThreadStorage({
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        collection: { threads: [], version: AGENT_THREAD_STORAGE_VERSION },
        revision: 0,
      });
    }) as typeof fetch,
  });

  await storage.load("standalone");
  assert.equal(authorization, null);
});

test("loads a lightweight thread index before fetching one transcript", async () => {
  const thread = createAgentThread(100, "Lazy thread");
  const requestedUrls: string[] = [];
  const storage = createHttpAgentThreadStorage({
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      const search = new URL(url, "http://agent.test").searchParams;
      if (search.get("view") === "index") {
        return Response.json({
          collection: {
            threads: [{ ...thread, events: [], hydration: "summary" }],
            version: AGENT_THREAD_STORAGE_VERSION,
          },
          revision: 4,
        });
      }
      return Response.json({ revision: 4, thread: { ...thread, hydration: "summary" } });
    }) as typeof fetch,
  });

  const index = await storage.load("workspace-lazy");
  assert.equal(index.threads[0]?.hydration, "summary");
  const hydrated = await storage.loadThread?.("workspace-lazy", thread.id);
  assert.equal(hydrated?.title, "Lazy thread");
  assert.equal(hydrated?.hydration, undefined);
  assert.match(requestedUrls[0] ?? "", /view=index/);
  assert.match(requestedUrls[1] ?? "", new RegExp(`threadId=${thread.id}`));
});

test("a server transcript repair advances the revision used by the next metadata save", async () => {
  const thread = {
    ...createAgentThread(100, "Repair me"),
    events: [],
    hydration: "summary" as const,
    session: { sessionId: "session-repair", streamIndex: 12_803 },
  };
  const repaired = {
    ...thread,
    events: [{
      data: { wait: "next-user-message" },
      meta: { at: new Date(0).toISOString(), id: "evt-repaired" },
      type: "session.waiting" as const,
    }],
    hydration: undefined,
    transcriptCoverage: { complete: true, endIndex: 12_803, startIndex: 0, version: 1 as const },
  };
  let savedIfMatch: string | null = null;
  let repairUrl: string | undefined;
  const storage = createHttpAgentThreadStorage({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/workspace-repair/repair?")) {
        repairUrl = url;
        return Response.json({ revision: 5, thread: repaired }, { headers: { etag: '"5"' } });
      }
      if (init?.method === "PATCH") {
        savedIfMatch = new Headers(init.headers).get("if-match");
        return Response.json({ revision: 6 }, { headers: { etag: '"6"' } });
      }
      return Response.json({
        collection: { activeThreadId: thread.id, threads: [thread], version: 2 },
        revision: 4,
      }, { headers: { etag: '"4"' } });
    }) as typeof fetch,
  });

  await storage.load("workspace-repair");
  const hydrated = await storage.repairThread?.("workspace-repair", thread.id);
  assert.equal(hydrated?.transcriptCoverage?.complete, true);
  assert.equal(repairUrl, `/api/agent/thread-collections/workspace-repair/repair?threadId=${encodeURIComponent(thread.id)}`);
  await storage.save("workspace-repair", {
    activeThreadId: thread.id,
    threads: [{ ...hydrated!, title: "Repaired" }],
    version: 2,
  });

  assert.equal(savedIfMatch, '"5"');
});

test("does not replace durable events with a shorter reconnect snapshot", async () => {
  const server = fakeThreadServer();
  const storage = createHttpAgentThreadStorage({
    fetch: server.fetch,
    getAccessToken: () => "test-token",
  });
  const initial = await storage.load("workspace-stale-reconnect");
  const firstEvent = {
    data: { message: "request", parts: [{ text: "request", type: "text" }], sequence: 0, turnId: "turn-0" },
    meta: { at: new Date(0).toISOString(), id: "event-request" },
    type: "message.received" as const,
  } satisfies MessageStreamEvent;
  const secondEvent = {
    data: { messageDelta: "answer", messageSoFar: "answer", sequence: 0, stepIndex: 0, turnId: "turn-0" },
    meta: { at: new Date(1).toISOString(), id: "event-answer" },
    type: "message.appended" as const,
  } satisfies MessageStreamEvent;
  const thread = {
    ...createAgentThread(100, "Stale reconnect"),
    events: [firstEvent, secondEvent],
  };
  await storage.save("workspace-stale-reconnect", {
    ...initial,
    activeThreadId: thread.id,
    threads: [thread],
  });

  const staleSnapshot = { ...thread, events: [secondEvent], updatedAt: 200 };
  await storage.save("workspace-stale-reconnect", {
    activeThreadId: thread.id,
    threads: [staleSnapshot],
    version: AGENT_THREAD_STORAGE_VERSION,
  });

  const patch = server.lastPatch();
  assert.equal(patch?.eventAppends?.length, 0);
  assert.deepEqual(patch?.upsertThreads?.[0]?.events, []);
});

test("does not treat a reordered snapshot as an append or replacement delta", async () => {
  const server = fakeThreadServer();
  const storage = createHttpAgentThreadStorage({
    fetch: server.fetch,
    getAccessToken: () => "test-token",
  });
  const initial = await storage.load("workspace-reordered-reconnect");
  const makeEvent = (id: string, message: string) => ({
    data: { messageDelta: message, messageSoFar: message, sequence: 0, stepIndex: 0, turnId: "turn-0" },
    meta: { at: new Date(0).toISOString(), id },
    type: "message.appended" as const,
  });
  const first = makeEvent("event-first", "first");
  const second = {
    data: { sequence: 0, stepIndex: 1, turnId: "turn-0" },
    meta: { at: new Date(1).toISOString(), id: "event-second" },
    type: "step.started" as const,
  };
  const thread = { ...createAgentThread(100, "Reordered"), events: [first, second] };
  await storage.save("workspace-reordered-reconnect", {
    ...initial,
    activeThreadId: thread.id,
    threads: [thread],
  });

  await storage.save("workspace-reordered-reconnect", {
    activeThreadId: thread.id,
    threads: [{ ...thread, events: [second, first], updatedAt: 200 }],
    version: AGENT_THREAD_STORAGE_VERSION,
  });

  const patch = server.lastPatch();
  assert.equal(patch?.eventAppends?.length, 0);
  assert.deepEqual(patch?.upsertThreads?.[0]?.events, []);
});

function fakeThreadServer() {
  let revision = 0;
  let collection: AgentThreadCollection = { threads: [], version: AGENT_THREAD_STORAGE_VERSION };
  let lastPatch: {
    readonly eventAppends?: readonly { readonly events: readonly MessageStreamEvent[]; readonly threadId: string }[];
    readonly upsertThreads?: readonly ReturnType<typeof createAgentThread>[];
  } | undefined;

  return {
    collection: () => collection as { readonly threads: readonly ReturnType<typeof createAgentThread>[] },
    lastPatch: () => lastPatch,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
      if (init?.method !== "PUT" && init?.method !== "PATCH") {
        return Response.json({ collection, revision }, { headers: { etag: `"${revision}"` } });
      }
      const expected = Number((new Headers(init.headers).get("if-match") ?? "").replaceAll('"', ""));
      if (expected !== revision) {
        return Response.json(
          { code: "thread_collection_conflict", ok: false },
          { status: 409, headers: { etag: `"${revision}"` } },
        );
      }
      const body = JSON.parse(String(init.body)) as {
        activeThreadId?: string | null;
        collection?: typeof collection;
        deletedThreadIds?: readonly string[];
        upsertThreads?: readonly ReturnType<typeof createAgentThread>[];
      };
      if (init.method === "PATCH") {
        lastPatch = body;
        const deleted = new Set(body.deletedThreadIds ?? []);
        const replacements = new Map((body.upsertThreads ?? []).map((thread) => [thread.id, thread]));
        const retained = collection.threads
          .filter((thread) => !deleted.has(thread.id))
          .map((thread) => replacements.get(thread.id) ?? thread);
        const retainedIds = new Set(retained.map((thread) => thread.id));
        collection = {
          ...(body.activeThreadId ? { activeThreadId: body.activeThreadId } : {}),
          threads: [
            ...(body.upsertThreads ?? []).filter((thread) => !retainedIds.has(thread.id)),
            ...retained,
          ],
          version: AGENT_THREAD_STORAGE_VERSION,
        };
      } else {
        collection = body.collection!;
      }
      revision += 1;
      return Response.json({ collection, revision }, { headers: { etag: `"${revision}"` } });
    }) as typeof fetch,
    revision: () => revision,
  };
}
