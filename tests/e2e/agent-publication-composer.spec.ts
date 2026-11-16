import { expect, test } from "@playwright/test";
import { NativeFixture, line, reply, startTurn } from "./native-fixture.ts";

test("empty and whitespace drafts cannot send while text and uploaded attachments can", async ({ page }) => {
  const fixture = new NativeFixture(page); fixture.seed(1); await fixture.install();
  const upload = Promise.withResolvers<void>();
  await page.route("**/api/assets/uploads", route => route.fulfill({ json: { upload: { assetId: "test-upload", uploadId: "test-upload", chunkSizeBytes: 5, partCount: 1, filename: "notes.txt", mediaType: "text/plain", sizeBytes: 5, transferStrategy: "proxy" } } }));
  await page.route("**/api/assets/uploads/test-upload/parts/1", route => route.fulfill({ json: { part: { partNumber: 1, sizeBytes: 5 } } }));
  await page.route("**/api/assets/uploads/test-upload/complete", async route => { await upload.promise; await route.fulfill({ json: { asset: { assetId: "test-upload", filename: "notes.txt", mediaType: "text/plain", sizeBytes: 5 } } }); });
  await page.goto("/threads/native-thread");
  const input = page.getByRole("textbox", { name: "Do anything" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await input.fill("   ");
  await expect(send).toBeDisabled();
  await input.press("Enter");
  expect(fixture.sends).toHaveLength(0);
  await input.fill("A follow-up");
  await expect(send).toBeEnabled();
  // Clear through the editor's keyboard path; fill("") can leave Lexical's
  // previous text intact in development builds.
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  await expect(input).toHaveText("");
  await expect(send).toBeDisabled();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add files", exact: true }).click();
  await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await expect(send).toBeDisabled();
  upload.resolve();
  await expect(send).toBeEnabled();
});

test("published history survives an empty registry with expiration and one version prefix", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = new NativeFixture(page); fixture.seed(1); await fixture.install();
  fixture.events.push(...startTurn(fixture.cursor, "publication", "publication-delivery", "Publish reports", "history-0"));
  for (const [id, expiresAt] of [["expired", "2020-01-01T00:00:00.000Z"], ["live", "2099-01-01T00:00:00.000Z"]]) {
    fixture.events.push(...line(fixture.cursor,
      { type: "call.requested", scope: { turnId: "publication" }, data: { callId: id!, owner: { runId: "publication:run" }, capability: { kind: "tool", name: "publish_artifact" }, input: { path: `/workspace/${id}.txt`, version: "v2" } } },
      { type: "call.started", scope: { turnId: "publication" }, data: { callId: id! } },
      { type: "call.settled", scope: { turnId: "publication" }, data: { callId: id!, outcome: "completed", output: { kind: "artifact", artifactId: id, filename: `${id}.txt`, version: "v2", mediaType: "text/plain", expiresAt, url: `/api/artifacts/${id}?token=original` } } }));
  }
  fixture.events.push(...reply(fixture.cursor, "publication", "publication-delivery", "Reports published"));
  let registry: unknown[] = [];
  await page.route("**/api/deliverables?*", route => route.fulfill({ json: { deliverables: registry } }));
  const reads: string[] = [];
  await page.route("**/api/artifacts/**", route => { reads.push(route.request().url()); return route.fulfill({ body: "A published report", contentType: "text/plain" }); });
  await page.goto("/threads/native-thread");
  const main = page.locator('[data-slot="agent-workbench"]');
  await expect(main.getByRole("button", { name: "Open expired.txt", exact: true })).toBeDisabled();
  await expect(main.getByRole("button", { name: "Open expired.txt", exact: true })).toContainText("Expired · v2");
  await page.getByRole("button", { name: "Open side view", exact: true }).click();
  const side = page.locator("[data-agent-secondary-view]");
  await side.getByRole("button", { name: /Published assets/ }).click();
  await expect(side.getByRole("button", { name: "Open expired.txt", exact: true })).toBeDisabled();
  await expect(side.getByRole("button", { name: "Open live.txt", exact: true })).toBeEnabled();
  await expect(side).not.toContainText("vv2");
  registry = [{ id: "live", kind: "artifact", title: "live.txt", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", version: "v2", mediaType: "text/plain", url: "/api/artifacts/live?token=refreshed" }];
  await side.getByRole("button", { name: "Refresh published assets", exact: true }).click();
  await side.getByRole("button", { name: "Open live.txt", exact: true }).click();
  await expect(side.getByText("A published report", { exact: true })).toBeVisible();
  // Strict Mode may restart the preview effect. Every request must use the
  // refreshed capability, including any request cancelled during that restart.
  expect(reads.length).toBeGreaterThan(0);
  for (const url of reads) expect(new URL(url).searchParams.get("token")).toBe("refreshed");
  await page.reload();
  await page.getByRole("button", { name: "Open side view", exact: true }).click();
  await side.getByRole("button", { name: /Published assets/ }).click();
  await expect(side.getByRole("button", { name: "Open expired.txt", exact: true })).toBeDisabled();
});
