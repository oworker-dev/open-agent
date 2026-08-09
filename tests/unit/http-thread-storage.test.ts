import assert from "node:assert/strict";
import test from "node:test";

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
      return Response.json({ revision: 4, thread });
    }) as typeof fetch,
  });

  const index = await storage.load("workspace-lazy");
  assert.equal(index.threads[0]?.hydration, "summary");
  const hydrated = await storage.loadThread?.("workspace-lazy", thread.id);
  assert.equal(hydrated?.title, "Lazy thread");
  assert.match(requestedUrls[0] ?? "", /view=index/);
  assert.match(requestedUrls[1] ?? "", new RegExp(`threadId=${thread.id}`));
});

function fakeThreadServer() {
  let revision = 0;
  let collection: AgentThreadCollection = { threads: [], version: AGENT_THREAD_STORAGE_VERSION };

  return {
    collection: () => collection as { readonly threads: readonly ReturnType<typeof createAgentThread>[] },
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
