import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createConnection } from "node:net";
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

test("uses an explicit configurable proxy socket budget", () => {
  assert.equal(readPreviewProxyMaxSockets({}), DEFAULT_PREVIEW_PROXY_MAX_SOCKETS);
  assert.equal(readPreviewProxyMaxSockets({ OPEN_AGENT_PREVIEW_PROXY_MAX_SOCKETS: "8192" }), 8_192);
  assert.throws(
    () => readPreviewProxyMaxSockets({ OPEN_AGENT_PREVIEW_PROXY_MAX_SOCKETS: "255" }),
    /must be an integer/u,
  );
});

test("does not trust caller-supplied forwarding headers", async (t) => {
  const upstream = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.headers));
  });
  const gateway = await startProductionPreviewGateway({
    eveOrigin: upstream.origin,
    host: "127.0.0.1",
    maxSockets: 256,
    port: 0,
    webOrigin: upstream.origin,
  });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });
  assert.ok(gateway.address && typeof gateway.address === "object");
  const response = await fetch(`http://127.0.0.1:${gateway.address.port}/headers`, {
    headers: {
      forwarded: "for=attacker.example",
      "x-forwarded-for": "203.0.113.99",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
      "x-real-ip": "203.0.113.99",
    },
  });
  const headers = await response.json() as Record<string, string>;
  assert.equal(headers.forwarded, undefined);
  assert.equal(headers["x-real-ip"], undefined);
  assert.equal(headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(headers["x-forwarded-proto"], "http");
  assert.notEqual(headers["x-forwarded-host"], "attacker.example");
});

test("rejects a malformed request URL without terminating the gateway", async (t) => {
  const upstream = await startFixture("web");
  const gateway = await startProductionPreviewGateway({
    eveOrigin: upstream.origin,
    host: "127.0.0.1",
    maxSockets: 256,
    port: 0,
    webOrigin: upstream.origin,
  });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });
  assert.ok(gateway.address && typeof gateway.address === "object");
  const statusLine = await rawRequest(
    gateway.address.port,
    "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
  );
  assert.match(statusLine, /^HTTP\/1\.1 400 /u);
  assert.equal(
    await (await fetch(`http://127.0.0.1:${gateway.address.port}/healthy`)).text(),
    "web:/healthy",
  );
});

test("survives an abrupt downstream disconnect", async (t) => {
  const upstream = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("stream-start\n");
  });
  const gateway = await startProductionPreviewGateway({
    eveOrigin: upstream.origin,
    host: "127.0.0.1",
    maxSockets: 256,
    port: 0,
    webOrigin: upstream.origin,
  });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });
  assert.ok(gateway.address && typeof gateway.address === "object");
  await abortAfterFirstChunk(gateway.address.port);
  const response = await fetch(`http://127.0.0.1:${gateway.address.port}/after-abort`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
});

test("admits more than 256 simultaneous upstream requests when configured", async (t) => {
  const expected = 257;
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const upstream = await startServer(async (_request, response) => {
    active += 1;
    peak = Math.max(peak, active);
    if (active === expected) release();
    await barrier;
    response.end("ok");
    active -= 1;
  });
  const gateway = await startProductionPreviewGateway({
    eveOrigin: upstream.origin,
    host: "127.0.0.1",
    maxSockets: 512,
    port: 0,
    webOrigin: upstream.origin,
  });
  t.after(async () => {
    release();
    await gateway.close();
    await upstream.close();
  });
  assert.ok(gateway.address && typeof gateway.address === "object");
  const port = gateway.address.port;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(Array.from({ length: expected }, () => httpGet(port, "/concurrent"))),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("concurrent gateway test timed out")), 10_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  assert.equal(peak, expected);
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
  return startServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${name}:${request.url}`);
  });
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void | Promise<void>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function abortAfterFirstChunk(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const request = get({ agent: false, host: "127.0.0.1", path: "/disconnect", port }, (response) => {
      response.once("data", () => {
        response.destroy();
        resolvePromise();
      });
    });
    request.once("error", reject);
  });
}

async function httpGet(port: number, path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const request = get({ agent: false, host: "127.0.0.1", path, port }, (response) => {
      response.resume();
      response.once("end", resolvePromise);
    });
    request.once("error", reject);
  });
}

async function rawRequest(port: number, payload: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolvePromise(response.split("\r\n", 1)[0] || ""));
    socket.once("error", reject);
  });
}
