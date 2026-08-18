import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSessionDeliverables,
  loadSessionDeliverables,
  mergeSessionDeliverables,
  resolveSessionDeliverableEndpoint,
} from "../../packages/agent-ui/src/agent-workspace/session-deliverables.ts";

test("session deliverable parser accepts bounded host-neutral records", () => {
  assert.deepEqual(parseSessionDeliverables({ deliverables: [{
    createdAt: "2029-01-01T00:00:00.000Z",
    expiresAt: "2029-01-02T00:00:00.000Z",
    fileCount: 4,
    id: "prv_1",
    kind: "website-preview",
    mediaType: "text/html",
    sizeBytes: 2048,
    title: "index.html",
    url: "/api/previews/prv_1/index.html?token=signed",
  }] }), [{
    createdAt: "2029-01-01T00:00:00.000Z",
    expiresAt: "2029-01-02T00:00:00.000Z",
    fileCount: 4,
    id: "prv_1",
    kind: "website-preview",
    mediaType: "text/html",
    sizeBytes: 2048,
    title: "index.html",
    url: "/api/previews/prv_1/index.html?token=signed",
  }]);
  assert.deepEqual(parseSessionDeliverables({ deliverables: [
    { createdAt: "now", id: "x", kind: "unknown", sizeBytes: 1, title: "bad", url: "javascript:alert(1)" },
    { createdAt: "now", id: "y", kind: "asset", sizeBytes: -1, title: "bad", url: "/asset" },
  ] }), []);
});

test("session deliverable endpoints support query and route templates", () => {
  assert.equal(resolveSessionDeliverableEndpoint("/api/deliverables", "session/a"), "/api/deliverables?sessionId=session%2Fa");
  assert.equal(resolveSessionDeliverableEndpoint("/host/{sessionId}/outputs", "session/a"), "/host/session%2Fa/outputs");
  assert.equal(resolveSessionDeliverableEndpoint((sessionId) => `/custom/${sessionId}`, "session-1"), "/custom/session-1");
});

test("legacy assets supplement an empty unified deliverable registry", () => {
  const assets = [{
    assetId: "asset-1",
    filename: "hero.png",
    mediaType: "image/png",
    sizeBytes: 12,
  }];
  assert.deepEqual(mergeSessionDeliverables([], assets), [{
    createdAt: "1970-01-01T00:00:00.000Z",
    id: "asset-1",
    kind: "asset",
    mediaType: "image/png",
    sizeBytes: 12,
    title: "hero.png",
    url: "/api/assets/asset-1",
  }]);
  const unified = {
    createdAt: "2029-01-01T00:00:00.000Z",
    id: "asset-1",
    kind: "asset" as const,
    mediaType: "image/png",
    sizeBytes: 12,
    title: "renamed.png",
    url: "/api/deliverables/asset-1",
  };
  assert.deepEqual(mergeSessionDeliverables([unified], assets), [unified]);
});

test("session deliverable loader applies host bearer auth and rejects unsafe endpoints", async () => {
  let request: Request | undefined;
  const deliverables = await loadSessionDeliverables({
    client: {
      auth: { bearer: async () => "host-token" },
      headers: { "x-agent-profile-id": "default" },
      host: "https://agent.test/service/",
    },
    endpoint: "/api/deliverables",
    fetcher: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ deliverables: [{
        createdAt: "2029-01-01T00:00:00.000Z",
        id: "art_1",
        kind: "artifact",
        sizeBytes: 10,
        title: "result.txt",
        url: "/api/artifacts/art_1?token=signed",
      }] });
    },
    sessionId: "session-1",
  });
  assert.equal(request?.url, "https://agent.test/api/deliverables?sessionId=session-1");
  assert.equal(request?.headers.get("authorization"), "Bearer host-token");
  assert.equal(request?.headers.get("x-agent-profile-id"), "default");
  assert.equal(deliverables[0]?.id, "art_1");
  await assert.rejects(
    loadSessionDeliverables({ endpoint: "javascript:alert(1)", fetcher: async () => Response.json({}), sessionId: "session-1" }),
    /HTTP\(S\)/,
  );
});
