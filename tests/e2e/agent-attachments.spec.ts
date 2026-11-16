import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { serializeAssetPrompt } from "@oworker/open-agent-contracts/asset";
import { NativeFixture, line, reply, startTurn } from "./native-fixture.ts";

const image = () => sharp({ create: { width: 240, height: 360, channels: 3, background: "#b7c4b0" } }).png().toBuffer();

async function uploads(page: Page, release: Promise<void>) {
  const pending = new Map<string, { assetId: string; uploadId: string; filename: string; mediaType: string; sizeBytes: number; chunkSizeBytes: number; partCount: number }>();
  await page.route("**/api/assets/upload-*", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/assets/uploads", async route => {
    const body = route.request().postDataJSON();
    const id = `upload-${pending.size}`;
    const upload = { ...body, assetId: id, uploadId: id, chunkSizeBytes: body.sizeBytes, partCount: 1 };
    pending.set(id, upload);
    await route.fulfill({ json: { upload } });
  });
  await page.route("**/api/assets/uploads/*/parts/1", route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-3)!;
    return route.fulfill({ json: { part: { partNumber: 1, sizeBytes: pending.get(id)!.sizeBytes } } });
  });
  await page.route("**/api/assets/uploads/*/complete", async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const asset = pending.get(id)!;
    if (asset.mediaType === "video/mp4") await release;
    await route.fulfill({ json: { asset } });
  });
}

test("composer keeps full image thumbnails and file preview tiles through upload, preview and removal", async ({ page }, info) => {
  const fixture = new NativeFixture(page); await fixture.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  const release = Promise.withResolvers<void>();
  await uploads(page, release.promise);
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add files", exact: true }).click();
  await (await chooser).setFiles([
    { name: "reference.png", mimeType: "image/png", buffer: await image() },
    { name: "genesis.html", mimeType: "text/html", buffer: Buffer.from("<h1>Reference</h1>") },
    { name: "唱歌进入.mp4", mimeType: "video/mp4", buffer: Buffer.from("video") },
  ]);
  const strip = page.locator("[data-composer-attachments]");
  await expect(strip.locator('[data-slot="attachment"]')).toHaveCount(3);
  const video = strip.locator('[data-attachment-kind="file"]').filter({ hasText: "唱歌进入.mp4" });
  const progress = video.getByRole("progressbar");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "100");
  const videoBox = await video.boundingBox(), progressBox = await progress.boundingBox();
  expect(progressBox!.x - videoBox!.x).toBeCloseTo(7, 0);
  expect(progressBox!.y - videoBox!.y).toBeCloseTo(7, 0);
  const removeBox = await video.getByRole("button", { name: "Remove attachment: 唱歌进入.mp4", exact: true }).boundingBox();
  expect(progressBox!.x + progressBox!.width).toBeLessThan(removeBox!.x);
  await page.screenshot({ path: info.outputPath("composer-uploading.png") });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  release.resolve();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(strip.getByRole("progressbar")).toHaveCount(0);
  const photo = strip.locator('[data-attachment-kind="image"]');
  await expect(photo).toHaveCSS("width", "96px");
  await expect(photo).toHaveCSS("height", "96px");
  await expect(photo.locator("img")).toHaveCSS("width", "96px");
  await expect(photo.locator("img")).toHaveCSS("height", "96px");
  await expect(strip.locator('[data-attachment-kind="file"]').first()).toHaveCSS("width", "144px");
  await expect(strip.locator('[data-attachment-kind="file"]').first()).toHaveCSS("height", "96px");
  await photo.getByRole("button", { name: "Attachment: reference.png", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "reference.png", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("composer-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await strip.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("composer-mobile.png") });
  await strip.getByRole("button", { name: "Remove attachment: reference.png", exact: true }).focus();
  await strip.getByRole("button", { name: "Remove attachment: reference.png", exact: true }).click();
  await expect(photo).toHaveCount(0);
  await expect(strip.getByText("genesis.html", { exact: true })).toBeVisible();
});

test("sent images stay above compact file pills with preview, download and refresh", async ({ page }, info) => {
  const fixture = new NativeFixture(page); fixture.seed(1); await fixture.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  const prompt = serializeAssetPrompt("Please inspect the attachments", [
    { id: "photo", mediaType: "image/png", name: "reference.png" },
    { id: "html", mediaType: "text/html", name: "genesis.html" },
    { id: "video", mediaType: "video/mp4", name: "唱歌进入.mp4" },
  ]);
  fixture.events.push(...startTurn(fixture.cursor, "files", "files-delivery", prompt, "history-0"));
  fixture.events.push(...reply(fixture.cursor, "files", "files-delivery", "Attachments received"));
  await page.route("**/api/assets/photo", async route => route.fulfill({ contentType: "image/png", body: await image() }));
  await page.route("**/api/assets/html", route => route.fulfill({ contentType: "text/html", body: "<h1>Safe source preview</h1>" }));
  await page.route("**/api/assets/video/download", route => route.fulfill({ json: { url: "/api/assets/video?downloadGrant=synthetic" } }));
  await page.route("**/api/assets/video?downloadGrant=*", route => route.fulfill({ body: "video", headers: { "content-disposition": "attachment; filename=video.mp4" } }));
  await page.goto("/threads/native-thread");
  const attachments = page.locator("[data-user-attachments]").last();
  const photo = attachments.locator('[data-attachment-kind="image"]');
  const files = attachments.locator('[data-user-file-attachments] [data-slot="attachment"]');
  await expect(files).toHaveCount(2);
  await expect(photo.locator("img")).toHaveCSS("width", "100px");
  await expect(files.first()).toHaveCSS("height", "40px");
  const photoBox = await photo.boundingBox(), fileBox = await files.first().boundingBox();
  expect(fileBox!.y).toBeGreaterThanOrEqual(photoBox!.y + photoBox!.height);
  await attachments.getByRole("button", { name: "Attachment: reference.png", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "reference.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await attachments.getByRole("button", { name: "Attachment: genesis.html", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("<h1>Safe source preview</h1>");
  expect(await page.evaluate(() => document.querySelector('[data-slot="dialog-content"] h1')?.textContent)).not.toBe("Safe source preview");
  await page.keyboard.press("Escape");
  const download = page.waitForEvent("download");
  await attachments.getByRole("button", { name: "Attachment: 唱歌进入.mp4", exact: true }).click();
  await (await download).cancel();
  await page.screenshot({ path: info.outputPath("sent-attachments.png") });
  await page.reload();
  await expect(files).toHaveCount(2);
  await expect(photo).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("consecutive image tools form a thumbnail gallery without hiding failures or other tools", async ({ page }, info) => {
  const fixture = new NativeFixture(page); fixture.seed(1); await fixture.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  let failPreview = true;
  await page.route("**/api/assets/view-*", async route => {
    if (route.request().url().endsWith("view-0") && failPreview) { failPreview = false; return route.fulfill({ status: 403, body: "expired" }); }
    return route.fulfill({ contentType: "image/png", body: await image() });
  });
  fixture.events.push(...startTurn(fixture.cursor, "view", "view-delivery", "Inspect five images", "history-0"));
  for (let i = 0; i < 5; i++) fixture.events.push(...line(fixture.cursor,
    { type: "call.requested", scope: { turnId: "view" }, data: { callId: `image-${i}`, owner: { runId: "view:run" }, capability: { kind: "tool", name: "view_image" }, input: { path: `/workspace/photo-${i}.png` } } },
    { type: "call.started", data: { callId: `image-${i}` } }));
  await page.goto("/threads/native-thread");
  const gallery = page.locator('[data-tool-view="view-images"]');
  await expect(gallery.getByRole("button", { name: "Viewing 5 images", exact: true })).toBeVisible();
  for (let i = 0; i < 5; i++) await fixture.publish(line(fixture.cursor, { type: "call.settled", data: { callId: `image-${i}`, outcome: "completed", output: { path: `/workspace/photo-${i}.png`, assetId: `view-${i}`, mediaType: "image/png", bytes: 500, dimensions: { width: 240, height: 360 } } } }));
  await expect(gallery.getByRole("button", { name: "Viewed 5 images", exact: true })).toBeVisible();
  await gallery.getByRole("button", { name: "Retry preview: /workspace/photo-0.png", exact: true }).click();
  await expect(gallery.getByRole("img")).toHaveCount(5);
  await expect(gallery.getByRole("img").first()).toHaveCSS("width", "100px");
  await gallery.getByRole("button", { name: "Preview /workspace/photo-0.png", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "/workspace/photo-0.png", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await gallery.getByRole("button", { name: "Viewed 5 images", exact: true }).click();
  await expect(gallery.getByRole("img")).toHaveCount(0);
  await gallery.getByRole("button", { name: "Viewed 5 images", exact: true }).click();
  await expect(gallery.getByRole("img")).toHaveCount(5);
  await page.screenshot({ path: info.outputPath("viewed-images.png") });
  await fixture.publish(line(fixture.cursor,
    { type: "call.requested", scope: { turnId: "view" }, data: { callId: "failed-image", owner: { runId: "view:run" }, capability: { kind: "tool", name: "view_image" }, input: { path: "/workspace/missing.png" } } },
    { type: "call.started", data: { callId: "failed-image" } },
    { type: "call.settled", data: { callId: "failed-image", outcome: "failed", error: { code: "NOT_FOUND", message: "Image not found" } } }));
  const failedTool = page.getByRole("button", { name: "Viewed image /workspace/missing.png Error", exact: true });
  await expect(failedTool).toBeVisible();
  await failedTool.click();
  await expect(page.getByText("Image not found", { exact: true })).toBeVisible();
  await expect(gallery.getByRole("button", { name: "Viewed 5 images", exact: true })).toBeVisible();
  await fixture.publish(line(fixture.cursor,
    { type: "call.requested", scope: { turnId: "view" }, data: { callId: "shell", owner: { runId: "view:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "pwd" } } },
    { type: "call.started", data: { callId: "shell" } },
    { type: "call.settled", data: { callId: "shell", outcome: "completed", output: "workspace" } }));
  const shell = page.getByRole("button", { name: "Terminal command pwd Completed", exact: true });
  await expect(shell).toBeVisible();
  await shell.click();
  await expect(page.getByText("workspace", { exact: true })).toBeVisible();
  await fixture.publish(line(fixture.cursor,
    { type: "call.requested", scope: { turnId: "view" }, data: { callId: "stopped-image", owner: { runId: "view:run" }, capability: { kind: "tool", name: "view_image" }, input: { path: "/workspace/stopped.png" } } },
    { type: "call.started", data: { callId: "stopped-image" } }));
  await expect(page.getByRole("button", { name: "Viewing 1 image", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const stoppedTool = page.getByRole("button", { name: "Viewed image /workspace/stopped.png Stopped", exact: true });
  await expect(stoppedTool).toBeVisible();
  await expect(page.getByRole("button", { name: "Viewing 1 image", exact: true })).toHaveCount(0);
  await stoppedTool.click();
  await expect(page.getByText("Tool call stopped before completion.", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(gallery.getByRole("img")).toHaveCount(5);
});
