import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedAssetPreviewUrl, MAX_TEXT_PREVIEW_BYTES, prepareBrowserAssetDownload, readBrowserAssetPreview, readBrowserAssetText } from "../../packages/agent-ui/src/agent-workspace/browser-asset-preview.ts";

const host = "https://agent.example";
const config = { host, headers: async () => ({ authorization: "Bearer synthetic-host-token" }) };

test("Host credentials are restricted to the configured service's asset endpoint", async () => {
  assert.equal(authenticatedAssetPreviewUrl("/api/assets/asset-1", host), host + "/api/assets/asset-1");
  for (const url of ["https://other.example/api/assets/asset-1", "//other.example/api/assets/asset-1", "/api/agent/sessions", "/api/assets/uploads/1", "/api/assets/a%2fb", "data:image/png,bytes"]) {
    assert.equal(authenticatedAssetPreviewUrl(url, host), undefined);
    await assert.rejects(readBrowserAssetPreview(url, config, new AbortController().signal, async () => { throw new Error("must not fetch"); }), /configured asset service/);
  }
});

test("persisted image preview uses the current authorization header and forbids redirects", async () => {
  let token = "first";
  const rotating = { host, auth: { bearer: () => token } };
  const received: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), host + "/api/assets/asset-1");
    assert.equal(String(url).includes("token"), false);
    assert.equal(init?.redirect, "error");
    received.push(new Headers(init?.headers).get("authorization")!);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  };
  const first = await readBrowserAssetPreview(host + "/api/assets/asset-1", rotating, new AbortController().signal, fetcher);
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3]);
  token = "second";
  await readBrowserAssetPreview(host + "/api/assets/asset-1", rotating, new AbortController().signal, fetcher);
  assert.deepEqual(received, ["Bearer first", "Bearer second"]);
});

test("failed authorization cannot become an image preview", async () => {
  await assert.rejects(readBrowserAssetPreview(host + "/api/assets/asset-1", config, new AbortController().signal,
    async () => new Response("forbidden", { status: 403 })), /403/);
});

test("preview decoding rejects executable content and excessive bytes", async () => {
  for (const mediaType of ["text/html", "image/svg+xml"]) await assert.rejects(
    readBrowserAssetPreview(host + "/api/assets/asset-1", config, new AbortController().signal,
      async () => new Response("content", { headers: { "content-type": mediaType } })), /cannot be previewed/);
  await assert.rejects(readBrowserAssetPreview(host + "/api/assets/asset-1", config, new AbortController().signal,
    async () => new Response("content", { headers: { "content-type": "image/png", "content-length": String(33 * 1024 * 1024) } })), /32 MiB/);
});

test("cancelled previews stop before sending credentials", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readBrowserAssetPreview(host + "/api/assets/asset-1", config, controller.signal,
    async () => { throw new Error("must not fetch"); }), { name: "AbortError" });
});

test("text preview authenticates asset reads and cancels oversized streams at its byte limit", async () => {
  let cancelled = false;
  let produced = 0;
  const result = await readBrowserAssetText(host + "/api/assets/asset-1", config, new AbortController().signal, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-host-token");
    assert.equal(init?.redirect, "error");
    return new Response(new ReadableStream({
      pull(controller) { produced++; controller.enqueue(new TextEncoder().encode("a".repeat(64 * 1024))); },
      cancel() { cancelled = true; },
    }));
  });
  assert.equal(result.text.length, MAX_TEXT_PREVIEW_BYTES);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
  assert(produced < 12);
});

test("text decoding preserves UTF-8 split across chunks and accepts empty files", async () => {
  const encoded = new TextEncoder().encode("创作文件");
  const result = await readBrowserAssetText(host + "/api/assets/asset-1", config, new AbortController().signal, async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } })));
  assert.deepEqual(result, { text: "创作文件", truncated: false });
  assert.deepEqual(await readBrowserAssetText(host + "/api/assets/asset-1", config, new AbortController().signal, async () => new Response(null)), { text: "", truncated: false });
});

test("signed or custom text URLs never receive the configured Host credential", async () => {
  const result = await readBrowserAssetText("https://files.example/signed/report.txt?signature=synthetic", config, new AbortController().signal, async (_url, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(init?.credentials, "omit");
    return new Response("report");
  });
  assert.equal(result.text, "report");
});

test("file downloads prepare a single-asset link without reading file bytes or placing Host tokens in URLs", async () => {
  const url = await prepareBrowserAssetDownload(host + "/api/assets/asset-1", config, new AbortController().signal, async (url, init) => {
    assert.equal(String(url), host + "/api/assets/asset-1/download");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-host-token");
    return Response.json({ url: "/api/assets/asset-1?downloadGrant=synthetic-read-only-grant" });
  });
  assert.equal(url, host + "/api/assets/asset-1?downloadGrant=synthetic-read-only-grant");
  for (const wrong of ["https://files.example/api/assets/asset-1?downloadGrant=x", "/api/assets/asset-2?downloadGrant=x", "/api/assets/asset-1", "/api/agent/sessions?downloadGrant=x"]) {
    await assert.rejects(prepareBrowserAssetDownload(host + "/api/assets/asset-1", config, new AbortController().signal, async () => Response.json({ url: wrong })), /invalid download link/);
  }
  assert.equal(await prepareBrowserAssetDownload("https://files.example/report.txt?signature=x", config, new AbortController().signal, async () => { throw new Error("must not fetch"); }), "https://files.example/report.txt?signature=x");
  await assert.rejects(prepareBrowserAssetDownload("javascript:alert(1)", config, new AbortController().signal), /cannot be downloaded/);
});
