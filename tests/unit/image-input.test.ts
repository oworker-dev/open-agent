import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { assetModelInputMiddleware } from "../../agent/lib/asset-model-input.ts";
import { prepareImagePreview, MAX_IMAGE_PREVIEW_BYTES, authorizedImageAsset } from "../../agent/lib/image-input.ts";
import { parseAssetPrompt, serializeAssetPrompt } from "../../packages/agent-contracts/src/asset.ts";
import { reconcilePendingTurnWithEvents } from "../../packages/agent-ui/dist/agent-workspace/thread-storage.js";

test("asset envelopes preserve identity independently of text and render legacy attachments cleanly", () => {
  const assets = [{ id: "asset-test", name: "test.png", mediaType: "image/png" }];
  const text = serializeAssetPrompt("看到什么", assets, "message-test-id");
  assert.deepEqual(parseAssetPrompt(text), { text: "看到什么", assets, clientMessageId: "message-test-id" });
  const legacy = `看到什么\n\n[open-agent-asset ${JSON.stringify(assets[0])}] Attached asset test.png. Use import_asset before inspecting or processing it.`;
  assert.deepEqual(parseAssetPrompt(legacy), { text: "看到什么", assets });
  const pending = { id: "message-test-id", text: "看到什么", submittedAt: 100, state: "submitting", files: [{ url: "asset://asset-test", mediaType: "image/png" }] } as const;
  const events = [{ type: "message.received", data: { message: text, turnId: "turn_0", sequence: 0 }, meta: { at: new Date(100).toISOString(), id: "event-id" } }] as const;
  assert.equal(reconcilePendingTurnWithEvents(pending, events), undefined);
  assert.equal(reconcilePendingTurnWithEvents({ ...pending, id: "other-message-id" }, events)?.id, "other-message-id");
  assert.equal(reconcilePendingTurnWithEvents(pending, [{ ...events[0], data: { ...events[0].data, message: legacy } }]), undefined);
  assert.ok(reconcilePendingTurnWithEvents({ ...pending, files: [{ url: "asset://different-image", mediaType: "image/png" }] }, [{ ...events[0], data: { ...events[0].data, message: legacy } }]));
});

test("image adaptation validates pixels, preserves small images and bounds a large source", async () => {
  const small = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  const preserved = await prepareImagePreview(small);
  assert.deepEqual(preserved.bytes, small);
  assert.equal(preserved.resized, false);
  const large = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "green" } }).png().toBuffer();
  const preview = await prepareImagePreview(large);
  assert.ok(preview.bytes.byteLength <= MAX_IMAGE_PREVIEW_BYTES);
  assert.equal(preview.width, 2048);
  assert.equal(preview.mediaType, "image/jpeg");
  const noisy = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  const noisyPreview = await prepareImagePreview(noisy);
  assert.ok(noisyPreview.bytes.byteLength <= MAX_IMAGE_PREVIEW_BYTES);
  assert.equal(noisyPreview.width, 768);
  await assert.rejects(prepareImagePreview(Buffer.from("not an image")));
  await assert.rejects(prepareImagePreview(large, AbortSignal.abort()), /abort/i);
});

test("model hydration supplies actual image parts without mutating durable history", async () => {
  const prompt = [{ role: "user", content: [{ type: "text", text: serializeAssetPrompt("看到什么", [{ id: "asset-test", mediaType: "image/png", name: "test.png" }], "message-test-id") }] }];
  const before = JSON.stringify(prompt);
  let reads = 0;
  const middleware = assetModelInputMiddleware({ session: { id: "session", auth: {} } }, async () => {
    reads++;
    return { bytes: Uint8Array.from([1, 2, 3]), width: 1, height: 1, mediaType: "image/png", originalBytes: 3, resized: false };
  });
  const result = await middleware.transformParams!({ params: { prompt } as never, model: {} as never, type: "stream" });
  assert.equal(JSON.stringify(prompt), before);
  assert.equal(reads, 1);
  assert.ok(JSON.stringify(result.prompt).includes('"type":"file"'));
  assert.ok(JSON.stringify(result.prompt).includes("AQID"));
  assert.ok(!JSON.stringify(result.prompt).includes("message-test-id"));
  assert.ok(!before.includes("AQID"));
});

test("image reads keep tenant and session authorization and bind first-turn uploads without a sandbox", async () => {
  const ctx = { session: { id: "session-test", auth: { current: { principalId: "user", principalType: "user", attributes: { tenantId: "tenant" } } } } } as const;
  const asset = { assetId: "asset-test", sessionId: "browser-initial", status: "ready", mediaType: "image/png", scanStatus: "clean", sizeBytes: 100 };
  let bound = false;
  const store = {
    async findAsset() { return asset; },
    async bindAssetSession(input: { sessionId: string }) { bound = true; return { ...asset, sessionId: input.sessionId }; },
  };
  assert.equal((await authorizedImageAsset("asset-test", ctx as never, store as never)).sessionId, "session-test");
  assert.equal(bound, true);
  await assert.rejects(authorizedImageAsset("asset-test", ctx as never, { async findAsset() { return { ...asset, sessionId: "other-session" }; } } as never), /different Agent session/);
});

test("the Responses wire contains visual input for uploads and replayed image tool results", async () => {
  const bodies: string[] = [];
  const provider = createOpenAI({ apiKey: "test-only", baseURL: "https://provider.invalid/v1", fetch: async (_url, init) => {
    bodies.push(String(init?.body));
    return Response.json({ id: "response-test", object: "response", created_at: 0, model: "test", status: "completed",
      output: [{ type: "message", id: "msg-test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Image received", annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
  } });
  const model = wrapLanguageModel({ model: provider("test"), middleware: assetModelInputMiddleware(
    { session: { id: "session", auth: {} } },
    async () => ({ bytes: Uint8Array.from([1, 2, 3]), width: 1, height: 1, mediaType: "image/png", originalBytes: 3, resized: false }),
  ) });
  await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: serializeAssetPrompt("Inspect", [{ id: "asset-test", name: "test.png", mediaType: "image/png" }]) }] }] });
  const replay = JSON.parse(JSON.stringify({ role: "tool", content: [{ type: "tool-result", toolCallId: "call-test", toolName: "view_image", output: { type: "json", value: { assetId: "asset-test" } } }] }));
  await model.doGenerate({ prompt: [
    { role: "user", content: [{ type: "text", text: "View the image" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-test", toolName: "view_image", input: '{"assetId":"asset-test"}' }] },
    replay,
  ] });
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.match(body, /"type":"input_image"/);
    assert.match(body, /data:image\/png;base64,AQID/);
  }
  assert.equal(JSON.stringify(replay).includes("AQID"), false);
});

test("historical images are bounded and deduplicated without hiding current image failures", async () => {
  const reads: string[] = [];
  const middleware = assetModelInputMiddleware({ session: { id: "session", auth: {} } }, async (id) => {
    reads.push(id);
    if (id === "asset-expired") throw new Error("Image expired");
    return { bytes: Uint8Array.from([1, 2, 3]), width: 1, height: 1, mediaType: "image/png", originalBytes: 3, resized: false };
  });
  const user = (id: string) => ({ role: "user", content: [{ type: "text", text: serializeAssetPrompt("Inspect", [{ id, name: "test.png", mediaType: "image/png" }]) }] });
  const hydrate = async (prompt: unknown[]) => middleware.transformParams!({ params: { prompt } as never, model: {} as never, type: "stream" });
  const result = await hydrate([...Array.from({ length: 10 }, (_, i) => user(`asset-${i}`)), user("asset-expired"), user("asset-9")]);
  assert.equal(reads.length, 8);
  assert.equal(reads.filter((id) => id === "asset-9").length, 1);
  assert.equal(result.prompt.flatMap((message) => message.role === "user" ? message.content.filter((part) => part.type === "file") : []).length, 7);
  await assert.rejects(hydrate([user("asset-expired")]), /Image expired/);
  const tooMany = { role: "user", content: [{ type: "text", text: serializeAssetPrompt("Inspect", Array.from({ length: 9 }, (_, i) => ({ id: `asset-${i}`, name: "test.png", mediaType: "image/png" }))) }] };
  await assert.rejects(hydrate([tooMany]), /up to 8 images/);
});
