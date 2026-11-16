import { expect, test } from "@playwright/test";
import { conversationOf } from "eve/client";
import { conversation } from "eve/events";
import { encodeMultiSelectAnswer } from "@oworker/open-agent-contracts";
import { parseAssetPrompt, serializeAssetPrompt } from "@oworker/open-agent-contracts/asset";
import { NativeFixture, line, reply, startTurn } from "./native-fixture.ts";

const fixtures = new WeakMap<object, NativeFixture>();
test.beforeEach(async ({page}) => {
  const fixture = new NativeFixture(page); fixtures.set(page, fixture); await fixture.install();
});

test("wide workspace supports navigation, search, settings, and a single draft session", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
  await expect(page.locator("aside").getByRole("button", { name: "New session", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible();
  await expect(page.getByText(/Changes could not be saved|当前更改暂未保存/)).toHaveCount(0);
  await expect(page.locator('[data-slot="model-selector-value"]')).toHaveCSS("font-size", "12px");
  await expect(page.locator('[data-workbench-panel]')).toHaveCSS("padding-top", "8px");
  await expect(page.locator('[data-slot="agent-workbench"]')).toHaveCSS("border-top-left-radius", "16px");
  await expect(page).toHaveURL(/\/$/);

  await page.locator("aside").getByRole("button", { name: "New session", exact: true }).first().click();
  await expect(page.locator("aside").getByText("New session", { exact: true })).toHaveCount(1);
  await expect(page.locator('aside [aria-current="page"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Search sessions" }).click();
  await page.getByPlaceholder("Search session history").fill("missing session");
  await expect(page.getByText("No sessions yet")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Software task", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No MCP connections are configured.")).toBeVisible();
  await page.getByRole("button", { name: "简体中文" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "做点什么" })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "做点什么" });
  await composer.click();
  await composer.press("/");
  await expect(page.getByText("技能与命令", { exact: true })).toHaveCount(0);
  await expect(composer).toHaveText("/");
  await composer.press("ControlOrMeta+A");
  await composer.press("Backspace");
  await expect(composer).toHaveText("");
  await composer.press("@");
  await expect(page.getByText("工作区上下文")).toBeVisible();
  await composer.press("Tab");
  await expect(page.locator('[data-directive-id="@workspace"]')).toBeVisible();

  await page.screenshot({ fullPage: true, path: "/tmp/open-agent-wide.png" });
});

test("model picker exposes only the selected GPT-6 model's reasoning levels", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Model" });
  await expect(picker).toContainText("GPT-6.1 Sol");
  await picker.click();

  const dialog = page.getByRole("dialog");
  const effort = dialog.getByRole("radiogroup", { name: "Reasoning" });
  await expect(effort.getByRole("radio", { name: "Max" })).toBeVisible();
  await expect(effort.getByRole("radio", { name: "None" })).toHaveCount(0);

  await dialog.locator('[data-slot="model-selector-item"]').filter({ hasText: "GPT-6 Luna" }).click();
  await picker.click();
  await expect(effort.getByRole("radio", { name: "None" })).toBeVisible();
  await expect(effort.getByRole("radio", { name: "Max" })).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  const effortBox = await effort.boundingBox();
  expect(dialogBox?.x).toBeGreaterThanOrEqual(0);
  expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(effortBox?.x).toBeGreaterThanOrEqual(dialogBox?.x ?? 0);
  expect((effortBox?.x ?? 0) + (effortBox?.width ?? 0)).toBeLessThanOrEqual((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0));
  await effort.getByRole("radio", { name: "None" }).click();

  await dialog.locator('[data-slot="model-selector-item"]').filter({ hasText: "GPT-6.1 Sol" }).click();
  await picker.click();
  await expect(effort.getByRole("radio", { name: "None" })).toHaveCount(0);
  await expect(effort.getByRole("radio", { name: "High", exact: true })).toHaveAttribute("data-state", "checked");
});

test("root stays clean and an unsent draft survives refresh", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await expect(page).toHaveURL(/\/$/);
  await composer.fill("Keep this draft across refresh");
  await page.waitForTimeout(350);
  await page.reload();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("textbox", { name: "Do anything" })).toHaveText("Keep this draft across refresh");
});

test("composer exposes assistant-ui attachments, permissions, and safe trigger selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add files" })).toBeVisible();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add files" }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    buffer: Buffer.from("attachment body"),
    mimeType: "text/plain",
    name: "brief.txt",
  });
  await expect(page.getByText("brief.txt", { exact: true })).toBeVisible();
  const imageChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add files" }).click();
  const imageChooser = await imageChooserPromise;
  await imageChooser.setFiles({
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    mimeType: "image/png",
    name: "reference.png",
  });
  const imageAttachment = page.locator('[data-slot="attachment"][data-orientation="vertical"]');
  await expect(imageAttachment).toBeVisible();
  await imageAttachment.getByRole("button", { name: "Attachment: reference.png", exact: true }).click();
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();

  await page.getByRole("button", { name: "Approval mode" }).click();
  await expect(page.getByText("Ask before commands and file changes.")).toBeVisible();
  await expect(page.getByText("Approve sandbox work automatically and ask before sensitive external actions.")).toBeVisible();
  await page.keyboard.press("Escape");

  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("@");
  await expect(page.getByText("Workspace context")).toBeVisible();
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("log").getByText("@", { exact: true })).toHaveCount(0);
});

test("small workspace keeps the conversation focused and opens navigation on demand", async ({ page }) => {
  await page.setViewportSize({ height: 969, width: 600 });
  await page.goto("/");

  const workbench = page.locator('[data-slot="agent-workbench"]');
  await expect(workbench).toHaveCSS("border-top-left-radius", "0px");
  await expect(workbench).toHaveCSS("border-left-width", "0px");
  await expect(workbench).toHaveCSS("border-top-width", "0px");
  await expect(workbench).toHaveCSS("box-shadow", "none");

  const inspectSuggestion = page.getByRole("button", { name: "Inspect this workspace and summarize what matters." });
  const implementSuggestion = page.getByRole("button", { name: "Help me plan and implement a small feature." });
  const inspectBox = await inspectSuggestion.boundingBox();
  const implementBox = await implementSuggestion.boundingBox();
  expect(Math.abs((inspectBox?.y ?? 0) - (implementBox?.y ?? 0))).toBeLessThanOrEqual(1);

  const sidebar = page.locator("aside");
  const closedBox = await sidebar.boundingBox();
  expect(closedBox?.x).toBeLessThan(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible();

  await page.screenshot({ fullPage: true, path: "/tmp/open-agent-small.png" });
});

test("desktop workbench keeps fullscreen transitions stable and exposes a resizable hover sidebar", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/");

  const workspace = page.locator(".open-agent-ui");
  const sidebar = page.locator("[data-sidebar-panel] aside");
  const separator = page.locator("[data-main-resize-handle]");
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  const workbench = page.locator("[data-workbench-panel]");

  await toggle.click();
  await expect(workspace).toHaveAttribute("data-workbench-mode", "collapsing");
  await expect(workspace).toHaveAttribute("data-workbench-mode", "fullscreen", { timeout: 1_000 });
  await expect(workspace).toHaveAttribute("data-workbench-fullscreen", "true");
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(1);
  await expect(workbench).toHaveCSS("padding-top", "0px");
  await expect(separator).toHaveAttribute("aria-disabled", "true");

  await page.waitForTimeout(450);
  await expect(workspace).toHaveAttribute("data-workbench-mode", "fullscreen");

  const fullscreenWorkbenchWidth = (await workbench.boundingBox())?.width ?? 0;
  const floatingSidebar = page.locator("[data-floating-sidebar]");
  await expect(floatingSidebar).toHaveAttribute("data-open", "false");
  await page.mouse.move(1, 450);
  await expect(floatingSidebar).toHaveAttribute("data-open", "true");

  const floatingHandle = page.locator("[data-floating-sidebar-handle]");
  await expect.poll(async () => (await floatingHandle.boundingBox())?.x ?? 0).toBeGreaterThan(280);
  const floatingPanel = page.locator("[data-floating-sidebar-panel]");
  const floatingBefore = await floatingPanel.boundingBox();
  expect(floatingBefore).not.toBeNull();
  const floatingHandleBox = await floatingHandle.boundingBox();
  expect(floatingHandleBox).not.toBeNull();
  await page.mouse.move(floatingHandleBox!.x + floatingHandleBox!.width / 2, 450);
  await page.mouse.down();
  await page.mouse.move(floatingHandleBox!.x + 72, 450, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => (await floatingPanel.boundingBox())?.width ?? 0).toBeGreaterThan((floatingBefore?.width ?? 0) + 50);
  await expect.poll(async () => (await workbench.boundingBox())?.width ?? 0).toBeCloseTo(fullscreenWorkbenchWidth, 0);

  await page.mouse.move(900, 450);
  await expect(floatingSidebar).toHaveAttribute("data-open", "false");

  await toggle.click();
  await expect(workspace).toHaveAttribute("data-workbench-mode", "expanding");
  await expect(workspace).toHaveAttribute("data-workbench-mode", "split", { timeout: 1_000 });
  await expect(workspace).toHaveAttribute("data-workbench-fullscreen", "false");
  await expect(workbench).toHaveCSS("padding-top", "8px");
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(200);

  const separatorBox = await separator.boundingBox();
  expect(separatorBox).not.toBeNull();

  await page.mouse.move(separatorBox!.x, separatorBox!.y + separatorBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, separatorBox!.y + separatorBox!.height / 2, { steps: 8 });
  await expect(workspace).toHaveAttribute("data-panel-resizing", "true");
  await expect(workspace).toHaveAttribute("data-workbench-mode", "split");
  await expect(workbench).toHaveCSS("padding-top", "8px");
  await page.mouse.up();

  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(1);
  await expect(workspace).toHaveAttribute("data-workbench-fullscreen", "true", { timeout: 1_000 });
  await expect(workbench).toHaveCSS("padding-top", "0px");
  await page.mouse.move(900, 450);
  await expect(floatingSidebar).toHaveAttribute("data-open", "false");
  await toggle.click();
  await expect(workspace).toHaveAttribute("data-workbench-mode", "split", { timeout: 1_000 });
  await expect(workspace).toHaveAttribute("data-workbench-fullscreen", "false");
  await expect(workbench).toHaveCSS("padding-top", "8px");
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(200);
});

test("narrow mobile workspace keeps menus inside the viewport", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Research a topic and cite the useful sources." })).toBeHidden();
  await expect(page.getByRole("button", { name: "Review a change and identify the highest-risk issues." })).toBeHidden();

  await page.getByRole("combobox", { name: "Model" }).click();
  const modelDialog = page.getByRole("dialog");
  await expect(modelDialog).toBeVisible();
  const effortGroup = page.getByRole("radiogroup", { name: "Reasoning" });
  await expect(effortGroup).toBeVisible();
  await expect(effortGroup.getByText("X high", { exact: true })).toBeVisible();
  const effortName = effortGroup.getByText("X high", { exact: true });
  await expect(modelDialog.locator('[data-slot="model-selector-item-name"]').first()).toHaveCSS("font-size", "12px");
  await expect(effortName).toHaveCSS("font-size", "12px");
  const dialogBox = await modelDialog.boundingBox();
  const effortBox = await effortGroup.boundingBox();
  expect(dialogBox?.x).toBeGreaterThanOrEqual(0);
  expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(effortBox?.x).toBeGreaterThanOrEqual(dialogBox?.x ?? 0);
  expect((effortBox?.x ?? 0) + (effortBox?.width ?? 0)).toBeLessThanOrEqual((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0));
  await page.keyboard.press("Escape");

  const composer = page.getByRole("textbox", { name: "Do anything" });
  const composerFrame = page.locator("form").filter({ has: composer });
  const composerBox = await composerFrame.boundingBox();
  expect(composerBox).not.toBeNull();
  expect((composerBox?.x ?? 0) + (composerBox?.width ?? 0)).toBeLessThanOrEqual(390);
  const sendButton = page.getByRole("button", { name: "Send" });
  const sendBox = await sendButton.boundingBox();
  expect(sendBox).not.toBeNull();
  expect((sendBox?.x ?? 0) + (sendBox?.width ?? 0)).toBeLessThanOrEqual(390);
  await composer.click();
  await composer.press("@");
  await expect(page.getByText("Workspace context")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ fullPage: true, path: "/tmp/open-agent-mobile.png" });
});

// All protocol fixtures below are native v27 facts and wire commits. Source
// cursors intentionally differ from fact counts (multi-fact atomic lines).
test("native successful conversation survives refresh without replay or duplicates", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => { f.events.push(...startTurn(f.cursor, "first", "delivery-1", String(body.message)), ...reply(f.cursor + 3, "first", "delivery-1", "First native reply")); };
  await page.goto("/"); await f.send("First native request");
  await expect(page.getByText("First native reply", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Working|Worked for|正在处理|已处理完成)/ })).toHaveCount(0);
  await expect.poll(() => f.collection.threads[0]?.events.length).toBe(f.events.length);
  await page.reload();
  await expect(page.getByRole("log").getByText("First native request", { exact: true })).toHaveCount(1);
  await expect(page.getByText("First native reply", { exact: true })).toHaveCount(1);
});

test("native plain-text streaming does not display the tool execution group", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => { await f.publish(startTurn(f.cursor, "plain", "delivery-plain", String(body.message))); };
  await page.goto("/");
  await f.send("A plain chat request");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const thinking = page.getByRole("button", { name: /^Thinking/ }).last();
  await expect(thinking).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Working|Worked for|正在处理|已处理完成)/ })).toHaveCount(0);

  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "plain", runId: "plain:run" }, data: {
    partId: "plain:reply", kind: "text", delta: "A plain chat response",
  } }));
  await expect(page.getByText("A plain chat response", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Thinking/ })).toHaveCount(0);

  await f.publish(reply(f.cursor, "plain", "delivery-plain", "A plain chat response"));
  await expect(page.getByText("A plain chat response", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Working|Worked for|正在处理|已处理完成)/ })).toHaveCount(0);
});

test("native tool calls retain the execution group", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => {
    await f.publish([
      ...startTurn(f.cursor, "tool", "delivery-tool", String(body.message)),
      ...line(f.cursor + 3,
        { type: "call.requested", scope: { turnId: "tool" }, data: { callId: "tool-call", owner: { runId: "tool:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf ok" } } },
        { type: "call.started", scope: { turnId: "tool" }, data: { callId: "tool-call" } }),
    ]);
  };
  await page.goto("/");
  await f.send("Run a tool");
  await expect(page.getByRole("button", { name: /^Working/ })).toBeVisible();

  await f.publish([
    ...line(f.cursor, { type: "call.settled", scope: { turnId: "tool" }, data: { callId: "tool-call", outcome: "completed", output: "ok" } }),
    ...reply(f.cursor + 1, "tool", "delivery-tool", "Tool result: ok"),
  ]);
  await expect(page.getByText("Tool result: ok", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Worked for/ })).toBeVisible();
});

for (const blank of ["absent", "preview", "completed"] as const) test(`empty thinking exits when tool input appears and stays absent during execution (${blank})`, async ({ page }) => {
  const f = fixtures.get(page)!;
  const turnId = "empty-thought";
  f.onSend = async (body) => f.publish(startTurn(f.cursor, turnId, "empty-delivery", String(body.message)));
  await page.goto("/");
  await f.send("Edit without a reasoning summary");
  const thought = page.locator('[data-slot="reasoning-trigger"]');
  await expect(thought).toHaveCount(1);
  if (blank === "preview") await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId, runId: `${turnId}:run` }, data: {
    partId: "blank", kind: "reasoning", delta: "\n ",
  } }));
  if (blank === "completed") await f.publish(line(f.cursor, { type: "content.completed", scope: { turnId }, data: {
    partId: "blank", runId: `${turnId}:run`, kind: "reasoning", phase: "narration", value: "",
  } }));
  await f.publish(line(f.cursor, { type: "call.input", scope: { turnId, runId: `${turnId}:run` }, data: {
    callId: "empty-file", kind: "tool", name: "edit_file", delta: '{"path":"empty.txt","old_string":"","new_string":"',
  } }));
  await expect(page.getByRole("button", { name: /^Editing/ })).toBeVisible();
  await expect(thought).toHaveCount(0);
  await page.waitForTimeout(1100);
  await expect(thought).toHaveCount(0);
  await f.publish(line(f.cursor,
    { type: "call.requested", scope: { turnId }, data: { callId: "empty-file", owner: { runId: `${turnId}:run` }, capability: { kind: "tool", name: "edit_file" }, input: { path: "empty.txt", old_string: "", new_string: "content" } } },
    { type: "call.started", scope: { turnId }, data: { callId: "empty-file" } }));
  await expect(page.getByRole("button", { name: /Creating empty.txt/ })).toBeVisible();
  await expect(thought).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Working/ })).toBeVisible();
  // A newer model step must retain its own placeholder even if an old tool runs.
  await f.publish(line(f.cursor,
    { type: "model.settled", scope: { turnId }, data: { runId: `${turnId}:run`, outcome: "completed", finishReason: "tool-calls" } },
    { type: "model.requested", scope: { turnId }, data: { runId: "after-tool", owner: { turnId } } },
    { type: "model.started", scope: { turnId }, data: { runId: "after-tool", modelId: "test", attempt: 0 } }));
  await expect(thought).toHaveCount(1);
  await expect(thought).toContainText("Thinking");
  await f.publish(line(f.cursor,
    { type: "model.retried", scope: { turnId }, data: { runId: "after-tool", attempt: 0, error: { code: "TRANSIENT", message: "Try again" } } },
    { type: "model.started", scope: { turnId }, data: { runId: "after-tool", modelId: "test", attempt: 1 } }));
  await expect(thought).toHaveCount(1);
  await expect(page.locator("[data-agent-retry]")).toHaveCount(1);
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId, runId: "after-tool" }, data: { partId: "reply", kind: "text", delta: "Reply after tool" } }));
  await expect(page.getByRole("log")).toContainText("Reply after tool");
  await expect(thought).toHaveCount(0);
});

test("reasoning completes its own timer and stays above tools through the next step", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => f.publish(startTurn(f.cursor, "thought-order", "thought-delivery", String(body.message))
    .map((event) => ({ ...event, meta: { ...event.meta, at: new Date(Date.now() - 5000).toISOString() } })));
  await page.goto("/");
  await f.send("Inspect the code");
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "thought-order", runId: "thought-order:run" }, data: { partId: "thought", kind: "reasoning", delta: "**Inspecting files**\n\nFirst paragraph." } }));
  const thought = page.locator('[data-slot="reasoning-trigger"]');
  await expect(thought).toContainText("Inspecting files");
  await expect(thought).not.toContainText("*");
  await f.publish(line(f.cursor,
    { type: "call.requested", scope: { turnId: "thought-order" }, data: { callId: "inspect-tool", owner: { runId: "thought-order:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf inspect" } } },
    { type: "call.started", scope: { turnId: "thought-order" }, data: { callId: "inspect-tool" } }));
  const tool = page.getByRole("button", { name: /printf inspect/ });
  await expect(tool).toBeVisible();
  const expectBefore = async () => expect((await thought.first().boundingBox())!.y).toBeLessThan((await tool.boundingBox())!.y);
  await expectBefore();
  await f.publish(line(f.cursor, { type: "content.completed", scope: { turnId: "thought-order" }, data: { partId: "thought", runId: "thought-order:run", kind: "reasoning", phase: "narration", value: "**Inspecting files**\n\nFirst paragraph." } })
    .map((event) => ({ ...event, meta: { ...event.meta, at: new Date(Date.now() - 2500).toISOString() } })));
  await expect(thought).toContainText("Reasoning complete");
  const label = await thought.textContent();
  await page.waitForTimeout(1200);
  await expect(thought).toHaveText(label!);
  await expectBefore();
  await f.publish(line(f.cursor,
    { type: "call.settled", scope: { turnId: "thought-order" }, data: { callId: "inspect-tool", outcome: "completed", output: "ok" } },
    { type: "model.settled", scope: { turnId: "thought-order" }, data: { runId: "thought-order:run", outcome: "completed", finishReason: "tool-calls" } },
    { type: "model.requested", scope: { turnId: "thought-order" }, data: { runId: "next-thought", owner: { turnId: "thought-order" } } },
    { type: "model.started", scope: { turnId: "thought-order" }, data: { runId: "next-thought", modelId: "test", attempt: 0 } }));
  await expect(thought).toHaveCount(2);
  await expectBefore();
  expect((await thought.last().boundingBox())!.y).toBeGreaterThan((await tool.boundingBox())!.y);
});

test("stopped file tools immediately stop animating and stay stopped after settlement", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => f.publish([...startTurn(f.cursor, "stop-file", "stop-file-delivery", String(body.message)),
    ...line(f.cursor + 3,
      { type: "call.requested", scope: { turnId: "stop-file" }, data: { callId: "file", owner: { runId: "stop-file:run" }, capability: { kind: "tool", name: "edit_file" }, input: { path: "example.txt", old_string: "before", new_string: "after" } } },
      { type: "call.started", scope: { turnId: "stop-file" }, data: { callId: "file" } })]);
  await page.goto("/");
  await f.send("Edit a file");
  const tool = page.getByRole("button", { name: /example.txt/ });
  await expect(tool.locator(".animate-spin")).toHaveCount(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(tool).toContainText("Stopped");
  await expect(tool.locator(".animate-spin")).toHaveCount(0);
  await f.publish(line(f.cursor,
    { type: "call.settled", scope: { turnId: "stop-file" }, data: { callId: "file", outcome: "interrupted" } },
    { type: "turn.settled", data: { turnId: "stop-file", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "stop-file-delivery", turnId: "stop-file", outcome: "handled" } }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(tool).toContainText("Stopped");
  await expect(tool.locator(".animate-spin")).toHaveCount(0);
});

test("a burst of file input remains incremental without blocking the composer", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => f.publish(startTurn(f.cursor, "file-burst", "burst-delivery", String(body.message)));
  await page.goto("/");
  await f.send("Receive a large file edit");
  await page.evaluate(() => {
    const browser = window as typeof window & { auditTasks: number[] };
    browser.auditTasks = [];
    new PerformanceObserver((list) => browser.auditTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
  });
  const input = JSON.stringify({ path: "burst.txt", old_string: "", new_string: "x".repeat(60_000) + "BURST_END" });
  const events = [];
  for (let offset = 0; offset < input.length; offset += 120) events.push(...line(f.cursor + events.length, { type: "call.input", scope: { turnId: "file-burst", runId: "file-burst:run" }, data: {
    callId: "burst-file", ...(offset === 0 ? { kind: "tool" as const, name: "edit_file" } : {}), delta: input.slice(offset, offset + 120),
  } }));
  await f.publish(events);
  const tool = page.getByRole("button", { name: /burst.txt/ });
  await expect(tool).toBeVisible();
  await tool.click();
  await expect(page.getByRole("log")).toContainText("BURST_END");
  await page.getByRole("textbox", { name: "Do anything" }).fill("Composer remains responsive");
  const longest = await page.evaluate(() => Math.max(0, ...(window as typeof window & { auditTasks: number[] }).auditTasks));
  expect(longest).toBeLessThan(1000);
});

test("rapid steering keeps each user, thought, and execution group in its own segment through replay", async ({ page }) => {
  const f = fixtures.get(page)!;
  const turnId = "steering";
  const stage = (index: number) => line(f.cursor,
    { type: "content.completed", scope: { turnId }, data: { partId: `thought-${index}`, runId: index ? `run-${index}` : `${turnId}:run`, kind: "reasoning", phase: "narration", value: `Thought ${index}` } },
    { type: "call.requested", scope: { turnId }, data: { callId: `tool-${index}`, owner: { runId: index ? `run-${index}` : `${turnId}:run` }, capability: { kind: "tool", name: "bash" }, input: { command: `printf stage-${index}` } } },
    { type: "call.started", scope: { turnId }, data: { callId: `tool-${index}` } },
    { type: "model.settled", scope: { turnId }, data: { runId: index ? `run-${index}` : `${turnId}:run`, outcome: "completed", finishReason: "tool-calls" } },
  );
  f.onSend = async body => {
    await f.publish(startTurn(f.cursor, turnId, "delivery-1", String(body.message)));
    await f.publish(stage(0));
  };
  f.onEdit = async body => {
    expect(body.operationKind).toBe("steer");
    const index = f.edits.length;
    await f.publish(line(f.cursor,
      { type: "call.settled", scope: { turnId }, data: { callId: `tool-${index - 1}`, outcome: "completed", output: `Stage ${index - 1} done` } },
      { type: "delivery.admitted", data: { deliveryId: `steer-${index}`, source: { channel: "eve" } } },
      { type: "delivery.consumed", scope: { turnId }, data: { deliveryId: `steer-${index}`, turnId, parts: [{ kind: "text", text: serializeAssetPrompt(String(body.message), [], String(body.clientMessageId)) }] } },
      { type: "model.requested", scope: { turnId }, data: { runId: `run-${index}`, owner: { turnId } } },
      { type: "model.started", scope: { turnId }, data: { runId: `run-${index}`, modelId: "test", attempt: 0 } },
    ));
    await f.publish(stage(index));
  };
  await page.goto("/");
  await f.send("Start the work");
  await expect(page.getByRole("button", { name: /^Working/ })).toHaveCount(1);
  for (let index = 1; index <= 3; index++) {
    await f.send(`Correction ${index}`);
    await expect(page.getByRole("button", { name: /^Reasoning complete/ })).toHaveCount(index + 1);
    await expect(page.getByRole("button", { name: /^Working/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Worked for/ })).toHaveCount(index);
  }
  const assertSegments = async () => {
    const rows = page.getByRole("log").locator("[data-message-id]");
    await expect(rows).toHaveCount(8);
    for (let index = 0; index <= 3; index++) {
      await expect(rows.nth(index * 2)).toContainText(index ? `Correction ${index}` : "Start the work");
      await expect(rows.nth(index * 2 + 1).getByRole("button", { name: /^Reasoning complete/ })).toHaveCount(1);
      for (let other = 0; other <= 3; other++) {
        if (other !== index) await expect(rows.nth(index * 2 + 1)).not.toContainText(`printf stage-${other}`);
      }
    }
  };
  await assertSegments();
  // Active-stream storage batches for 15s after the last urgent queue update.
  // Include that interval and the live checkpoint cadence before reloading.
  await expect.poll(() => f.collection.threads[0]?.events.length, { timeout: 20_000 }).toBe(f.events.length);
  await f.disconnect();
  await assertSegments();
  await page.reload();
  await assertSegments();
});

test("batched steering keeps both user boundaries and streams tool input and output in the new segment", async ({ page }) => {
  const f = fixtures.get(page)!;
  const turnId = "batched";
  f.onSend = async body => {
    await f.publish(startTurn(f.cursor, turnId, "delivery-1", String(body.message)));
    await f.publish(line(f.cursor,
      { type: "content.completed", scope: { turnId }, data: { partId: "initial-thought", runId: `${turnId}:run`, kind: "reasoning", phase: "narration", value: "Initial thought" } },
      { type: "model.settled", scope: { turnId }, data: { runId: `${turnId}:run`, outcome: "interrupted" } },
    ));
  };
  await page.goto("/");
  await f.send("Initial request");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  for (const text of ["First queued correction", "Second queued correction"]) {
    await composer.fill(text);
    await composer.press("Enter");
  }
  await expect.poll(() => f.edits.length).toBe(2);
  const consumed = f.edits.flatMap((body, index) => [
    { type: "delivery.admitted" as const, data: { deliveryId: `batch-${index}`, source: { channel: "eve" } } },
    { type: "delivery.consumed" as const, scope: { turnId }, data: { deliveryId: `batch-${index}`, turnId, parts: [{ kind: "text" as const, text: serializeAssetPrompt(String(body.message), [], String(body.clientMessageId)) }] } },
  ]);
  await f.publish(line(f.cursor, ...consumed,
    { type: "model.requested", scope: { turnId }, data: { runId: "batch-run", owner: { turnId } } },
    { type: "model.started", scope: { turnId }, data: { runId: "batch-run", modelId: "test", attempt: 0 } },
  ));
  const rows = page.getByRole("log").locator("[data-message-id]");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("Initial request");
  await expect(rows.nth(2)).toContainText("First queued correction");
  await expect(rows.nth(3)).toContainText("Second queued correction");
  await expect(rows.nth(4).getByRole("button", { name: /^Thinking/ })).toHaveCount(1);
  await f.publish(line(f.cursor, { type: "call.input", scope: { turnId, runId: "batch-run" }, data: {
    callId: "streamed-tool", kind: "tool", name: "bash", delta: '{"command":"printf streamed',
  } }));
  const tool = rows.nth(4).getByRole("button", { name: /printf streamed/ });
  await expect(tool).toHaveCount(1);
  await f.publish(line(f.cursor, { type: "call.input", scope: { turnId, runId: "batch-run" }, data: {
    callId: "streamed-tool", delta: ' input"}',
  } }));
  await expect(rows.nth(4).getByRole("button", { name: /printf streamed input/ })).toHaveCount(1);
  await f.publish(line(f.cursor,
    { type: "call.requested", scope: { turnId }, data: { callId: "streamed-tool", owner: { runId: "batch-run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf streamed input" } } },
    { type: "call.started", scope: { turnId }, data: { callId: "streamed-tool" } },
  ));
  await tool.click();
  for (const stdout of ["Partial output", "Partial output plus more"]) {
    await f.publish(line(f.cursor, { type: "call.progress", scope: { turnId, runId: "batch-run" }, data: {
      callId: "streamed-tool", output: { stdout },
    } }));
    await expect(rows.nth(4).getByText(stdout, { exact: true })).toBeVisible();
  }
  await f.publish(line(f.cursor, { type: "call.settled", scope: { turnId }, data: {
    callId: "streamed-tool", outcome: "completed", output: { stdout: "Final output" },
  } }));
  await expect(rows.nth(4).getByText("Final output", { exact: true })).toBeVisible();
  await expect(rows.nth(4)).not.toContainText("Partial output");
  await expect(rows.nth(1)).not.toContainText("printf streamed");
  // The active stream's checkpoint debounce is 15s; include its save cadence.
  await expect.poll(() => f.collection.threads[0]?.events.length, { timeout: 20_000 }).toBe(f.events.length);
  await page.reload();
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(2)).toContainText("First queued correction");
  await expect(rows.nth(3)).toContainText("Second queued correction");
  await expect(rows.nth(4).getByRole("button", { name: /printf streamed input/ })).toHaveCount(1);
});

test("successive identical prompts stay distinct after acceptance and refresh", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => {
    const count = f.sendCount;
    await f.publish([
      ...startTurn(f.cursor, `repeat-${count}`, `delivery-${count}`, String(body.message), count === 1 ? null : `repeat-${count - 1}`),
      ...reply(f.cursor + 3, `repeat-${count}`, `delivery-${count}`, `Reply ${count}`),
    ]);
  };
  await page.goto("/");
  for (let count = 1; count <= 2; count++) {
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Do anything" });
    await composer.fill("Same request");
    await composer.press("Enter");
    await expect(page.getByText(`Reply ${count}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("log").getByText("Same request", { exact: true })).toHaveCount(count);
  }
  expect(f.sendCount).toBe(2);
  await page.reload();
  await expect(page.getByRole("log").getByText("Same request", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Reply 1", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Reply 2", { exact: true })).toHaveCount(1);
});

for (const freeform of [false, true]) test(`question cards submit ${freeform ? "free text" : "an option"} through the mailbox and survive refresh`, async ({ page }) => {
  const f = fixtures.get(page)!;
  const turnId = "question";
  const answer: Record<string, string> = freeform ? { text: "Use plain text" } : { optionId: "Markdown" };
  f.onSend = async (body) => {
    await f.publish(startTurn(f.cursor, turnId, "question-delivery", String(body.message)));
    await f.publish(line(f.cursor,
      { type: "call.requested", scope: { turnId }, data: { callId: "ask-format", owner: { runId: `${turnId}:run` }, capability: { kind: "tool", name: "ask_question" }, input: { question: "Which output format should I use?" } } },
      { type: "call.started", scope: { turnId }, data: { callId: "ask-format" } },
      { type: "model.settled", scope: { turnId }, data: { runId: `${turnId}:run`, outcome: "completed", finishReason: "tool-calls" } },
      { type: "interaction.opened", scope: { turnId }, data: { interactionId: "format", subject: { callId: "ask-format" }, request: { kind: "question", prompt: "Which output format should I use?", display: "select", allowFreeform: true, options: [{ id: "Markdown", label: "Markdown" }, { id: "JSON", label: "JSON" }] } } },
      { type: "turn.paused", data: { turnId, awaiting: [{ interactionId: "format" }] } },
    ));
  };
  f.onEdit = async (body) => {
    expect(body.operationKind).toBe("respond");
    expect(body.inputResponses).toEqual([{ interactionId: "format", ...answer }]);
    f.mailboxStatus = "committed";
    await f.publish(line(f.cursor,
      { type: "interaction.settled", scope: { turnId }, data: { interactionId: "format", outcome: "accepted", response: answer } },
      { type: "call.settled", scope: { turnId }, data: { callId: "ask-format", outcome: "completed", output: { status: "answered", answer: freeform ? answer.text : answer.optionId } } },
      { type: "model.requested", scope: { turnId }, data: { runId: "after-question", owner: { turnId } } },
      { type: "model.started", scope: { turnId }, data: { runId: "after-question", modelId: "test", attempt: 0 } },
      { type: "content.completed", scope: { turnId }, data: { partId: "format-reply", runId: "after-question", kind: "text", phase: "reply", value: "Format confirmed" } },
      { type: "model.settled", scope: { turnId }, data: { runId: "after-question", outcome: "completed", finishReason: "stop" } },
      { type: "turn.settled", data: { turnId, outcome: "completed", reply: ["format-reply"] } },
      { type: "delivery.settled", data: { deliveryId: "question-delivery", turnId, outcome: "handled" } },
    ));
  };
  await page.goto("/");
  await f.send("Help me choose an output format");
  const card = page.locator('[data-input-request-kind="question"]');
  await expect(card.getByRole("paragraph").filter({ hasText: "Which output format should I use?" })).toBeVisible();
  if (freeform) await card.getByRole("textbox", { name: "Additional information" }).fill(answer.text!);
  else await card.getByRole("radio", { name: "Markdown", exact: true }).check();
  await card.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Format confirmed", { exact: true })).toBeVisible();
  expect(f.edits).toHaveLength(1);
  await expect.poll(() => f.collection.threads.some((thread) => thread.events.some((event) => event.type === "turn.settled"))).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Format confirmed", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("log").getByText("Help me choose an output format", { exact: true })).toHaveCount(1);
});

test("multi-select question submits and restores selected options and additional text", async ({ page }) => {
  const f = fixtures.get(page)!;
  const turnId = "question-multi";
  const responseText = encodeMultiSelectAnswer({
    additionalText: "Keep it concise.",
    optionIds: ["Markdown", "JSON"],
  });
  f.onSend = async (body) => {
    await f.publish(startTurn(f.cursor, turnId, "question-multi-delivery", String(body.message)));
    await f.publish(line(f.cursor,
      { type: "call.requested", scope: { turnId }, data: { callId: "ask-format-multi", owner: { runId: `${turnId}:run` }, capability: { kind: "tool", name: "ask_question" }, input: { question: "Which formats should I prepare?", multiple: true } } },
      { type: "call.started", scope: { turnId }, data: { callId: "ask-format-multi" } },
      { type: "model.settled", scope: { turnId }, data: { runId: `${turnId}:run`, outcome: "completed", finishReason: "tool-calls" } },
      { type: "interaction.opened", scope: { turnId }, data: { interactionId: "format-multi", subject: { callId: "ask-format-multi" }, request: { kind: "question", prompt: "Which formats should I prepare?", display: "select", allowFreeform: true, options: [{ id: "Markdown", label: "Markdown" }, { id: "JSON", label: "JSON" }, { id: "CSV", label: "CSV" }] } } },
      { type: "turn.paused", data: { turnId, awaiting: [{ interactionId: "format-multi" }] } },
    ));
  };
  f.onEdit = async (body) => {
    expect(body.operationKind).toBe("respond");
    expect(body.inputResponses).toEqual([{ interactionId: "format-multi", text: responseText }]);
    f.mailboxStatus = "committed";
    await f.publish(line(f.cursor,
      { type: "interaction.settled", scope: { turnId }, data: { interactionId: "format-multi", outcome: "accepted", response: { text: responseText } } },
      { type: "call.settled", scope: { turnId }, data: { callId: "ask-format-multi", outcome: "completed", output: { status: "answered", answer: "Selected options:\n- Markdown\n- JSON\n\nAdditional information:\nKeep it concise." } } },
      { type: "model.requested", scope: { turnId }, data: { runId: "after-multi-question", owner: { turnId } } },
      { type: "model.started", scope: { turnId }, data: { runId: "after-multi-question", modelId: "test", attempt: 0 } },
      { type: "content.completed", scope: { turnId }, data: { partId: "multi-format-reply", runId: "after-multi-question", kind: "text", phase: "reply", value: "Formats confirmed" } },
      { type: "model.settled", scope: { turnId }, data: { runId: "after-multi-question", outcome: "completed", finishReason: "stop" } },
      { type: "turn.settled", data: { turnId, outcome: "completed", reply: ["multi-format-reply"] } },
      { type: "delivery.settled", data: { deliveryId: "question-multi-delivery", turnId, outcome: "handled" } },
    ));
  };

  await page.goto("/");
  await f.send("Prepare the formats");
  const card = page.locator('[data-input-request-kind="question"]');
  await expect(card.getByRole("checkbox", { name: "Markdown", exact: true })).toBeVisible();
  await card.getByRole("checkbox", { name: "Markdown", exact: true }).check();
  await card.getByRole("checkbox", { name: "JSON", exact: true }).check();
  await card.getByRole("textbox", { name: "Additional information" }).fill("Keep it concise.");
  await card.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Formats confirmed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Worked for/ }).click();
  await card.getByRole("button").first().click();
  await expect(card.locator('[data-option-selected="true"]')).toHaveCount(2);
  await expect(card.getByText("Keep it concise.", { exact: true })).toBeVisible();
  expect(f.edits).toHaveLength(1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^Worked for/ }).click();
  const restoredCard = page.locator('[data-input-request-kind="question"]');
  await restoredCard.getByRole("button").first().click();
  await expect(restoredCard.locator('[data-option-selected="true"]')).toHaveCount(2);
  await expect(restoredCard.getByText("Keep it concise.", { exact: true })).toBeVisible();
});

test("a paused approval can stop its exact turn without sending an approval decision", async ({ page }) => {
  const f = fixtures.get(page)!;
  const turnId = "approval-to-cancel";
  f.onSend = async body => {
    const start = f.cursor;
    await f.publish(startTurn(start, turnId, "approval-delivery", String(body.message)));
    await f.publish(line(f.cursor,
      { type: "call.requested", scope: { turnId }, data: { callId: "pending-write", owner: { runId: `${turnId}:run` }, capability: { kind: "tool", name: "host_invoke" }, input: { capability: "canvas.node.put" } } },
      { type: "model.settled", scope: { turnId }, data: { runId: `${turnId}:run`, outcome: "completed", finishReason: "tool-calls" } },
      { type: "interaction.opened", scope: { turnId }, data: { interactionId: "write-approval", subject: { callId: "pending-write" }, request: { kind: "approval", prompt: "Write to the canvas?" } } },
      { type: "turn.paused", data: { turnId, awaiting: [{ interactionId: "write-approval" }] } },
    ));
  };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.onCancel = async () => { await held; };
  await page.goto("/");
  await f.send("Prepare one canvas write");
  const approval = page.locator("[data-agent-approval-takeover]");
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => f.cancellations).toEqual([turnId]);
  expect(f.edits).toEqual([]);
  await expect(approval.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect(approval.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(approval.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  release();
  await f.publish(line(f.cursor,
    { type: "interaction.settled", data: { interactionId: "write-approval", outcome: "interrupted" } },
    { type: "call.settled", scope: { turnId }, data: { callId: "pending-write", outcome: "interrupted" } },
    { type: "turn.settled", data: { turnId, outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "approval-delivery", turnId, outcome: "handled" } },
  ));
  await expect(approval).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await page.reload();
  await expect(approval).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible();
  f.onSend = async body => {
    const start = f.cursor;
    await f.publish([...startTurn(start, "after-stop", "follow-up", String(body.message), turnId), ...reply(start + 3, "after-stop", "follow-up", "Ready for a new task")]);
  };
  await f.send("Continue in the same session");
  await expect(page.getByText("Ready for a new task", { exact: true })).toBeVisible();
  expect(f.cancellations).toEqual([turnId]);
  expect(f.edits).toEqual([]);
});

for (const history of [false, true]) test(`composer clears while admission waits and stop before receipt preserves one user message (history=${history})`, async ({ page }) => {
  const f = fixtures.get(page)!;
  if (history) f.seed(1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.onSend = async (body) => { await held; await f.publish(startTurn(f.cursor, "delayed", "delivery-1", String(body.message))); };
  await page.goto(history ? "/threads/native-thread" : "/"); await f.send("Delayed admission");
  await expect(page.getByRole("textbox", { name: "Do anything" })).toHaveText("");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stopping", exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText("Delayed admission", { exact: true })).toHaveCount(1);
  expect(f.cancellations).toEqual([]);
  release();
  await expect.poll(() => f.cancellations).toEqual(["delayed"]);
  await f.publish(line(f.cursor, { type: "turn.settled", data: { turnId: "delayed", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "delivery-1", turnId: "delayed", outcome: "handled" } }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText("Delayed admission", { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("log").getByText("Delayed admission", { exact: true })).toHaveCount(1);
});

test("stop during a rejected admission preserves the prompt and releases the composer", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/eve/v1/session", async (route) => {
    await held;
    await route.fulfill({ status: 400, json: { error: "Admission rejected" } });
  });
  await page.goto("/");
  await fixtures.get(page)!.send("Rejected admission");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stopping", exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText("Rejected admission", { exact: true })).toHaveCount(1);
  expect(fixtures.get(page)!.cancellations).toEqual([]);
});

test("stop during an ambiguous first admission keeps the composer locked without replaying", async ({ page }) => {
  let release!: () => void;
  let submissions = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/eve/v1/session", async (route) => {
    submissions++;
    await held;
    await route.fulfill({ status: 503, json: { error: "Receipt unavailable" } });
  });
  await page.goto("/");
  await fixtures.get(page)!.send("Uncertain admission");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  release();
  await expect(page.getByText(/HTTP 503/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stopping", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.getByRole("log").getByText("Uncertain admission", { exact: true })).toHaveCount(1);
  expect(submissions).toBe(1);
});

for (const scrolled of [false, true]) test(`plain chat follows the bottom without pushing the user to the top (history scrolled=${scrolled})`, async ({ page }) => {
  const f = fixtures.get(page)!; f.seed(22);
  let submittedMessage = "";
  f.onSend = async (body) => { submittedMessage = String(body.message); };
  await page.goto("/threads/native-thread");
  await expect(page.getByRole("log").getByText("History request 21", { exact: true })).toBeVisible();
  const viewport = page.locator('[data-slot="thread-viewport"]');
  if (scrolled) await viewport.evaluate((element) => { element.scrollTop = 0; });
  await f.send("A new chat message");
  const user = page.getByRole("log").getByText("A new chat message", { exact: true });
  await expect(user).toBeVisible();
  const thinking = page.getByRole("log").getByText("Thinking", { exact: true }).last();
  await expect(thinking).toBeVisible();
  await expect.poll(async () => (await user.boundingBox())!.y - (await viewport.boundingBox())!.y).toBeGreaterThan(150);
  await expect.poll(async () => {
    const before = (await user.boundingBox())!.y;
    await page.waitForTimeout(100);
    return Math.abs((await user.boundingBox())!.y - before);
  }).toBeLessThan(1);
  const initial = await user.boundingBox();
  const placeholder = await thinking.boundingBox();
  const viewportBox = await viewport.boundingBox();
  expect(initial!.y - viewportBox!.y).toBeGreaterThan(150);
  expect(placeholder!.y - (initial!.y + initial!.height)).toBeLessThan(110);
  await expect.poll(() => submittedMessage).not.toBe("");
  await f.publish(startTurn(f.cursor, "anchored", "delivery-1", submittedMessage, "history-21"));
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "anchored", runId: "anchored:run" }, data: {
    partId: "anchored:reply", kind: "text", delta: "Response begins here.",
  } }));
  await expect(page.getByText("Response begins here.", { exact: true })).toBeVisible();
  expect((await user.boundingBox())!.y - viewportBox!.y).toBeGreaterThan(150);
  await f.publish(reply(f.cursor, "anchored", "delivery-1", "Response begins here."));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect((await user.boundingBox())!.y - viewportBox!.y).toBeGreaterThan(150);
  await expect(page.locator('[data-slot="task-scroll-reserve"]')).toHaveCSS("height", "0px");
  const longReply = Array.from({ length: 65 }, (_, index) => `Chat paragraph ${index}.`).join("\n\n");
  // A second chat can grow beyond the viewport and still follow its output.
  f.onSend = async body => { await f.publish(startTurn(f.cursor, "long-chat", "delivery-2", String(body.message), "anchored")); };
  await f.send("Continue chatting");
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "long-chat", runId: "long-chat:run" }, data: {
    partId: "long-chat:reply", kind: "text", delta: longReply,
  } }));
  await expect(page.getByText("Chat paragraph 64.", { exact: true })).toBeInViewport();
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
});

for (const mobile of [false, true]) test(`only the first execution group pushes up; streaming, collapse and the next chat keep their scroll policy (mobile=${mobile})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const f = fixtures.get(page)!; f.seed(22);
  f.onSend = async body => { await f.publish(startTurn(f.cursor, "task-anchor", "delivery-1", String(body.message), "history-21")); };
  await page.goto("/threads/native-thread");
  await f.send("Work on this task");
  const viewport = page.locator('[data-slot="thread-viewport"]');
  const user = page.getByRole("log").getByText("Work on this task", { exact: true });
  const offset = async () => (await user.boundingBox())!.y - (await viewport.boundingBox())!.y;
  await expect.poll(offset).toBeGreaterThan(150);
  await f.publish(line(f.cursor, { type: "content.completed", scope: { turnId: "task-anchor" }, data: {
    partId: "task-thought", runId: "task-anchor:run", kind: "reasoning", phase: "narration", value: "Consider the task first.",
  } }));
  await expect(page.getByRole("button", { name: /^Reasoning complete/ })).toBeVisible();
  await expect.poll(offset).toBeGreaterThan(150);
  await f.publish(line(f.cursor,
    { type: "call.requested", scope: { turnId: "task-anchor" }, data: { callId: "anchor-tool", owner: { runId: "task-anchor:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf ok" } } },
    { type: "call.started", scope: { turnId: "task-anchor" }, data: { callId: "anchor-tool" } }));
  await expect(page.getByRole("button", { name: /^Working/ })).toBeVisible();
  await expect.poll(offset).toBeLessThan(25);
  await page.waitForTimeout(250); // allow the single smooth scroll to finish
  const anchoredOffset = await offset();
  await f.publish(line(f.cursor, { type: "call.settled", scope: { turnId: "task-anchor" }, data: { callId: "anchor-tool", outcome: "completed", output: "ok" } }));
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "task-anchor", runId: "task-anchor:run" }, data: {
    partId: "task-anchor:reply", kind: "text", delta: "Task complete.",
  } }));
  await expect(page.getByText("Task complete.", { exact: true })).toBeVisible();
  expect(Math.abs(await offset() - anchoredOffset)).toBeLessThan(8);
  const furtherOutput = Array.from({ length: 40 }, (_, index) => `Task result paragraph ${index}.`).join("\n\n");
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "task-anchor", runId: "task-anchor:run" }, data: {
    partId: "task-anchor:reply", kind: "text", delta: `\n\n${furtherOutput}`,
  } }));
  await expect(page.getByText("Task result paragraph 39.", { exact: true })).toHaveCount(1);
  await page.waitForTimeout(150);
  expect(Math.abs(await offset() - anchoredOffset)).toBeLessThan(8);
  await f.publish(reply(f.cursor, "task-anchor", "delivery-1", `Task complete.\n\n${furtherOutput}`));
  await expect(page.getByRole("button", { name: /^Worked for/ })).toBeVisible();
  await page.waitForTimeout(350); // group collapse must preserve the anchor too
  expect(Math.abs(await offset() - anchoredOffset)).toBeLessThan(8);
  await page.getByRole("button", { name: "Scroll to bottom", exact: true }).click();
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);

  f.onSend = async body => { await f.publish(startTurn(f.cursor, "next-chat", "delivery-2", String(body.message), "task-anchor")); };
  await f.send("Thanks, just chatting now");
  const nextUser = page.getByRole("log").getByText("Thanks, just chatting now", { exact: true });
  await expect.poll(async () => (await nextUser.boundingBox())!.y - (await viewport.boundingBox())!.y).toBeGreaterThan(150);
  await expect(page.locator('[data-slot="task-scroll-reserve"]')).toHaveCSS("height", "0px");
});

for (const beforeReceipt of [false, true]) test(`reading history before a tool appears prevents task anchoring and later output from stealing the viewport (before receipt=${beforeReceipt})`, async ({ page }) => {
  const f = fixtures.get(page)!; f.seed(22);
  f.onSend = async body => {
    if (!beforeReceipt) await f.publish(startTurn(f.cursor, "reading", "delivery-1", String(body.message), "history-21"));
  };
  await page.goto("/threads/native-thread");
  await f.send("Start while I read history");
  const viewport = page.locator('[data-slot="thread-viewport"]');
  await expect(page.getByRole("log").getByText("Start while I read history", { exact: true })).toBeVisible();
  await viewport.hover({ position: { x: 20, y: 100 } });
  await page.mouse.wheel(0, -550);
  await page.waitForTimeout(300);
  const readingTop = await viewport.evaluate(element => element.scrollTop);
  if (beforeReceipt) await f.publish(startTurn(f.cursor, "reading", "delivery-1", String(f.sends[0]!.message), "history-21"));
  await f.publish(line(f.cursor,
    { type: "call.requested", scope: { turnId: "reading" }, data: { callId: "reading-tool", owner: { runId: "reading:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf ok" } } },
    { type: "call.started", scope: { turnId: "reading" }, data: { callId: "reading-tool" } }));
  await expect(page.getByRole("button", { name: /^Working/ })).toHaveCount(1);
  await f.publish(reply(f.cursor, "reading", "delivery-1", "Reading stays where you left it."));
  await page.waitForTimeout(350);
  expect(Math.abs(await viewport.evaluate(element => element.scrollTop) - readingTop)).toBeLessThan(8);
  await expect(page.locator('[data-slot="task-scroll-reserve"]')).toHaveCSS("height", "0px");
});

test("same-turn follow-ups receive their own task anchor and replay does not reactivate it", async ({ page }) => {
  const f = fixtures.get(page)!; f.seed(22);
  const turnId = "follow-anchor";
  const tool = (index: number) => line(f.cursor,
    { type: "call.requested", scope: { turnId }, data: { callId: `follow-tool-${index}`, owner: { runId: index ? "follow-run" : `${turnId}:run` }, capability: { kind: "tool", name: "bash" }, input: { command: "printf ok" } } },
    { type: "call.started", scope: { turnId }, data: { callId: `follow-tool-${index}` } });
  f.onSend = async body => { await f.publish(startTurn(f.cursor, turnId, "delivery-1", String(body.message), "history-21")); await f.publish(tool(0)); };
  f.onEdit = async body => {
    await f.publish(line(f.cursor,
      { type: "delivery.admitted", data: { deliveryId: "follow-delivery", source: { channel: "eve" } } },
      { type: "delivery.consumed", scope: { turnId }, data: { deliveryId: "follow-delivery", turnId, parts: [{ kind: "text", text: serializeAssetPrompt(String(body.message), [], String(body.clientMessageId)) }] } },
      { type: "model.requested", scope: { turnId }, data: { runId: "follow-run", owner: { turnId } } },
      { type: "model.started", scope: { turnId }, data: { runId: "follow-run", modelId: "test", attempt: 0 } }));
    await f.publish(tool(1));
  };
  await page.goto("/threads/native-thread"); await f.send("First task segment");
  const viewport = page.locator('[data-slot="thread-viewport"]');
  const offset = async (text: string) => (await page.getByRole("log").getByText(text, { exact: true }).boundingBox())!.y - (await viewport.boundingBox())!.y;
  await expect.poll(() => offset("First task segment")).toBeLessThan(25);
  await f.send("Follow-up task segment");
  await expect.poll(() => offset("Follow-up task segment")).toBeLessThan(25);
  await f.publish(reply(f.cursor, turnId, "delivery-1", "Both segments done."));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect.poll(() => f.collection.threads[0]?.events.length).toBe(f.events.length);
  await page.reload();
  await expect(page.getByText("Both segments done.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="task-scroll-reserve"]')).toHaveCSS("height", "0px");
});

test("opening or refreshing an already running task does not activate a new task anchor", async ({ page }) => {
  const f = fixtures.get(page)!; f.seed(22);
  f.events.push(...startTurn(f.cursor, "resumed-task", "resumed-delivery", "An existing running task", "history-21"));
  f.events.push(...line(f.cursor,
    { type: "call.requested", scope: { turnId: "resumed-task" }, data: { callId: "resumed-tool", owner: { runId: "resumed-task:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf ok" } } },
    { type: "call.started", scope: { turnId: "resumed-task" }, data: { callId: "resumed-tool" } }));
  await page.goto("/threads/native-thread");
  await expect(page.getByRole("button", { name: /^Working/ })).toBeVisible();
  await expect(page.locator('[data-slot="task-scroll-reserve"]')).toHaveCSS("height", "0px");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Working/ })).toBeVisible();
  await expect(page.locator('[data-slot="task-scroll-reserve"]')).toHaveCSS("height", "0px");
});

test("stop freezes visible output immediately while durable cancellation is still pending", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => { f.events.push(...startTurn(f.cursor, "stop-turn", "delivery-1", String(body.message))); };
  await page.goto("/"); await f.send("Stop this response");
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "stop-turn", runId: "stop-turn:run" }, data: {
    partId: "stop-turn:reply", kind: "text", delta: "Visible before stop.",
  } }));
  await expect(page.getByText("Visible before stop.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stopping", exact: true })).toBeVisible();
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "stop-turn", runId: "stop-turn:run" }, data: {
    partId: "stop-turn:reply", kind: "text", delta: " LATE_OUTPUT_MUST_STAY_HIDDEN",
  } }));
  await expect(page.getByText(/LATE_OUTPUT_MUST_STAY_HIDDEN/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect.poll(() => f.cancellations).toEqual(["stop-turn"]);
  await f.publish(line(f.cursor, { type: "model.settled", scope: { turnId: "stop-turn", runId: "stop-turn:run" }, data: { runId: "stop-turn:run", outcome: "interrupted" } },
    { type: "turn.settled", data: { turnId: "stop-turn", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "delivery-1", turnId: "stop-turn", outcome: "handled" } }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("log").getByText("Stop this response", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/LATE_OUTPUT_MUST_STAY_HIDDEN/)).toHaveCount(0);
});

test("send during cancellation reaches Eve immediately and a late cancel receipt cannot lock the next turn", async ({ page }) => {
  const f = fixtures.get(page)!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.onCancel = async (turnId) => { if (turnId === "old") await held; };
  f.onSend = async (body) => {
    if (f.sendCount === 1) f.events.push(...startTurn(f.cursor, "old", "delivery-1", String(body.message)));
  };
  await page.goto("/"); await f.send("First stopped request");
  await expect.poll(() => f.collection.threads[0]?.events.some((e) => e.type === "delivery.consumed")).toBe(true);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => f.cancellations).toEqual(["old"]);
  await f.send("Send before cancellation returns");
  await expect.poll(() => f.sendCount).toBe(2);
  expect(f.sends[1]?.turnPolicy).toBe("queue");
  expect(f.collection.threads[0]?.queuedTurns).toEqual([]);
  const start = f.cursor;
  await f.publish([
    ...line(start, { type: "turn.settled", data: { turnId: "old", outcome: "cancelled" } },
      { type: "delivery.settled", data: { deliveryId: "delivery-1", turnId: "old", outcome: "handled" } }),
    ...startTurn(start + 1, "new", "delivery-2", String(f.sends[1]!.message), "old"),
  ]);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  release();
  await page.waitForTimeout(120);
  await expect(page.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => f.cancellations).toEqual(["old", "new"]);
  await f.publish(line(f.cursor, { type: "turn.settled", data: { turnId: "new", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "delivery-2", turnId: "new", outcome: "handled" } }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("log").getByText("First stopped request", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("log").getByText("Send before cancellation returns", { exact: true })).toHaveCount(1);
});

test("stopping only a queued follow-up never cancels the next turn", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.seed(1);
  f.collection = { ...f.collection, threads: f.collection.threads.map((thread) => ({
    ...thread,
    queuedTurns: [{
      id: "queued-followup", mailboxItemId: "queued-item", delivery: "server" as const,
      state: "queued" as const, submittedAt: Date.now(), text: "Withdraw this queued message",
    }],
  })) };
  let withdrawn = false;
  await page.route("**/api/standalone/mailbox/queued-item", (route) => {
    if (route.request().method() === "DELETE") withdrawn = true;
    return route.fulfill({ json: { ok: true, item: {
      itemId: "queued-item", clientMessageId: "queued-followup", status: withdrawn ? "cancelled" : "queued",
    } } });
  });
  f.onSend = async (body) => {
    await f.publish(startTurn(f.cursor, "next-turn", "next-delivery", String(body.message), "history-0"));
  };
  await page.goto("/threads/native-thread");
  await expect(page.getByText("Withdraw this queued message", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await f.send("New message immediately after stop");
  await expect.poll(() => f.sendCount).toBe(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(withdrawn).toBe(true);
  expect(f.cancellations).toEqual([]);
  await f.publish(reply(f.cursor, "next-turn", "next-delivery", "The new turn survived"));
  await expect(page.getByText("The new turn survived", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(f.cancellations).toEqual([]);
});

test("stop before the first receipt then send keeps one session and cancels only the original delivery", async ({ page }) => {
  const f = fixtures.get(page)!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.onSend = async (body) => {
    if (f.sendCount === 1) {
      await held;
      await f.publish(startTurn(f.cursor, "first", "delivery-1", String(body.message)));
    }
  };
  await page.goto("/"); await f.send("Stop before creation receipt");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await f.send("Immediate next request");
  await expect(page.getByRole("log").getByText("Stop before creation receipt", { exact: true })).toHaveCount(1);
  release();
  await expect.poll(() => f.sendCount).toBe(2);
  await expect.poll(() => f.cancellations).toEqual(["first"]);
  expect(f.sends[1]?.turnPolicy).toBe("queue");
  await f.publish(line(f.cursor, { type: "turn.settled", data: { turnId: "first", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "delivery-1", turnId: "first", outcome: "handled" } }));
  await f.publish(startTurn(f.cursor, "second", "delivery-2", String(f.sends[1]!.message), "first"));
  await f.publish(reply(f.cursor, "second", "delivery-2", "New request completed"));
  await expect(page.getByText("New request completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("log").getByText("Stop before creation receipt", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("log").getByText("Immediate next request", { exact: true })).toHaveCount(1);
});

test("refresh during stop and resend retains the old cancellation target", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.seed(1);
  f.onSend = async (body) => {
    if (f.sendCount === 1) await f.publish(startTurn(f.cursor, "cancel-target", "delivery-1", String(body.message), "history-0"));
  };
  await page.goto("/threads/native-thread"); await f.send("Original request");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => f.cancellations).toEqual(["cancel-target"]);
  await f.send("Resent request");
  await expect.poll(() => f.sendCount).toBe(2);
  await expect.poll(() => f.collection.threads[0]?.pendingTurn?.text).toBe("Resent request");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible();
  const start = f.cursor;
  await f.publish([
    ...line(start, { type: "turn.settled", data: { turnId: "cancel-target", outcome: "cancelled" } },
      { type: "delivery.settled", data: { deliveryId: "delivery-1", turnId: "cancel-target", outcome: "handled" } }),
    ...startTurn(start + 1, "resend-target", "delivery-2", String(f.sends[1]!.message), "cancel-target"),
  ]);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(f.cancellations.every((id) => id === "cancel-target")).toBe(true);
  await f.publish(reply(f.cursor, "resend-target", "delivery-2", "Resent request completed"));
  await expect(page.getByText("Resent request completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

for (const admission of ["before-consumed", "after-consumed"] as const) test(`edit then immediately stop keeps one replacement through refresh (${admission})`, async ({ page }) => {
  const f = fixtures.get(page)!; f.seed(2);
  await page.goto("/threads/native-thread");
  await expect(page.getByText("History reply 1", { exact: true })).toBeVisible();
  await f.edit("Replacement request");
  await expect.poll(() => f.edits.length).toBe(1);
  const body = f.edits[0]!;
  expect(body.operationKind).toBe("edit"); expect(body.beforeTurnId).toBe("history-1");
  const accept = async () => {
    const prefix = [{ id: "history-delivery-0:user", role: "user" as const, text: "History request 0" },
      { id: "history-0:assistant", role: "assistant" as const, text: "History reply 0" }];
    await f.publish(line(f.cursor, { type: "context.started", data: { changeId: "clear-edit", kind: "clear" } },
      { type: "context.settled", data: { changeId: "clear-edit", kind: "clear", outcome: "completed", selects: null } }));
    const parsed = parseAssetPrompt(String(body.message));
    const message = serializeAssetPrompt(parsed.text, parsed.assets, String(body.clientMessageId));
    await f.publish(startTurn(f.cursor, "replacement", "edit-delivery", message).map((event) =>
      event.type === "delivery.consumed" ? { ...event, data: { ...event.data, history: prefix } } : event));
    f.mailboxStatus = "committed";
  };
  if (admission === "after-consumed") await accept();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("log").getByText("Replacement request", { exact: true })).toHaveCount(1);
  if (admission === "before-consumed") await accept();
  await expect.poll(() => f.cancellations).toContain("replacement");
  await f.publish(line(f.cursor, { type: "turn.settled", data: { turnId: "replacement", outcome: "cancelled" } },
    { type: "delivery.settled", data: { deliveryId: "edit-delivery", turnId: "replacement", outcome: "handled" } }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText("History request 1", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("log").getByText("History request 0", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("log").getByText("Replacement request", { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("log").getByText("Replacement request", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("log").getByText("History request 1", { exact: true })).toHaveCount(0);
});

test("native reconnect resumes source lines without duplicating multi-fact messages", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => { f.events.push(...startTurn(f.cursor, "reconnect", "delivery-1", String(body.message))); };
  await page.goto("/"); await f.send("Reconnect request");
  // Disconnect an observed, checkpointed stream. The pending placeholder can
  // already have become a running activity before this assertion executes.
  await expect.poll(() => f.collection.threads[0]?.events.some((event) =>
    event.type === "delivery.consumed" && event.data.turnId === "reconnect",
  )).toBe(true);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await f.disconnect();
  f.events.push(...reply(f.cursor, "reconnect", "delivery-1", "Recovered native response"));
  await expect(page.getByText("Recovered native response", { exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText("Reconnect request", { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("Recovered native response", { exact: true })).toHaveCount(1);
});

test("storage conflict preserves source order and retries the native checkpoint", async ({ page }) => {
  const f = fixtures.get(page)!;
  f.onSend = async (body) => { f.events.push(...startTurn(f.cursor, "conflict", "delivery-1", String(body.message)), ...reply(f.cursor + 3, "conflict", "delivery-1", "Saved after conflict")); };
  await page.goto("/"); f.conflictsRemaining = 1; await f.send("Save despite conflict");
  await expect(page.getByText("Saved after conflict", { exact: true })).toBeVisible();
  await expect.poll(() => f.collection.threads[0]?.events.length).toBe(f.events.length);
  const events = f.collection.threads[0]!.events;
  expect(conversation(conversationOf(events).view).map((turn) => turn.turnId)).toEqual(["conflict"]);
  await expect(page.getByText(/Changes could not be saved/)).toHaveCount(0);
});
