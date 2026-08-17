import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSessionDeliverables,
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
