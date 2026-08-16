import assert from "node:assert/strict";
import test from "node:test";
import { assetContentDisposition, safeAssetContentType } from "../../server/http/asset-content.ts";

test("asset responses never execute uploaded document media", () => {
  assert.equal(safeAssetContentType("image/png"), "image/png");
  assert.equal(safeAssetContentType("image/svg+xml"), "application/octet-stream");
  assert.equal(safeAssetContentType("text/html"), "application/octet-stream");
  assert.equal(assetContentDisposition("text/html", "report\"\r\n.html"), "attachment; filename=\"report___.html\"");
});
