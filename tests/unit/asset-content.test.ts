import assert from "node:assert/strict";
import test from "node:test";
import { assetContentDisposition, safeAssetContentType } from "../../server/http/asset-content.ts";

test("asset responses never execute uploaded document media", () => {
  assert.equal(safeAssetContentType("image/png"), "image/png");
  assert.equal(safeAssetContentType("image/svg+xml"), "application/octet-stream");
  assert.equal(safeAssetContentType("text/html"), "application/octet-stream");
  const disposition = assetContentDisposition("text/html", "report\"\r\n.html");
  assert.match(disposition, /^attachment; filename="report___\.html";/);
  assert.equal(/[\r\n]/u.test(disposition), false);
  assert.doesNotThrow(() => new Response("bytes", { headers: { "content-disposition": disposition } }));
});

test("Unicode attachment names produce valid HTTP headers and preserve the original filename", () => {
  const filename = "参考图 人像（原片）.png";
  const disposition = assetContentDisposition("image/png", filename);
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-disposition": disposition } });
  assert.equal(response.status, 200);
  assert.match(disposition, /^inline; filename="[\x20-\x7E]+"; filename\*=UTF-8''/u);
  assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]!), filename);
});

test("malformed Unicode filenames cannot break an asset download", () => {
  assert.doesNotThrow(() => new Headers({ "content-disposition": assetContentDisposition("image/png", "image\uD800.png") }));
});

test("explicit downloads force attachment disposition even for normally inline media", () => {
  assert.match(assetContentDisposition("image/png", "image.png", true), /^attachment;/u);
});
