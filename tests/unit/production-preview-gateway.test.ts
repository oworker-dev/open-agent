import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  DEFAULT_PREVIEW_PROXY_MAX_SOCKETS,
  readPreviewProxyMaxSockets,
  selectProductionPreviewTarget,
  startProductionPreviewGateway,
} from "../../scripts/production-preview-gateway.mjs";

test("routes Eve and Workflow traffic around the Next rewrite proxy", () => {
  const targets = { eve: "http://127.0.0.1:4275", web: "http://127.0.0.1:3101" };
  assert.equal(selectProductionPreviewTarget("/eve/v1/session/id/stream", targets), targets.eve);
  assert.equal(selectProductionPreviewTarget("/.well-known/workflow/v1/callback", targets), targets.eve);
  assert.equal(selectProductionPreviewTarget("/threads/id", targets), targets.web);
});

test("uses a configurable proxy socket budget instead of Next's fixed 256", () => {
  assert.equal(readPreviewProxyMaxSockets({}), DEFAULT_PREVIEW_PROXY_MAX_SOCKETS);
  assert.equal(readPreviewProxyMaxSockets({ OPEN_AGENT_PREVIEW_PROXY_MAX_SOCKETS: "8192" }), 8_192);
  assert.throws(
    () => readPreviewProxyMaxSockets({ OPEN_AGENT_PREVIEW_PROXY_MAX_SOCKETS: "255" }),
    /must be an integer/u,
  );
});

test("streams public routes to the selected loopback service", async (t) => {
  const web = await startFixture("web");
  const eve = await startFixture("eve");
  const gateway = await startProductionPreviewGateway({
    eveOrigin: eve.origin,
    host: "127.0.0.1",
    maxSockets: 256,
    port: 0,
    webOrigin: web.origin,
  });
  t.after(async () => {
    await gateway.close();
    await Promise.all([web.close(), eve.close()]);
  });
  assert.ok(gateway.address && typeof gateway.address === "object");
  const origin = `http://127.0.0.1:${gateway.address.port}`;
  assert.equal(await (await fetch(`${origin}/threads/one`)).text(), "web:/threads/one");
  assert.equal(await (await fetch(`${origin}/eve/v1/health`)).text(), "eve:/eve/v1/health");
  assert.equal(
    await (await fetch(`${origin}/.well-known/workflow/callback`)).text(),
    "eve:/.well-known/workflow/callback",
  );
});

async function startFixture(name: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${name}:${request.url}`);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}
