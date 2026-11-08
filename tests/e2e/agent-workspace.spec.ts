import { expect, test } from "@playwright/test";
import { conversationOf } from "eve/client";
import { conversation } from "eve/events";
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
  await imageAttachment.getByRole("button", { name: "Attachment: reference.png" }).click();
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
  await expect.poll(() => f.collection.threads[0]?.events.length).toBe(f.events.length);
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

for (const scrolled of [false, true]) test(`new turn anchors its user and adjacent placeholder through response (history scrolled=${scrolled})`, async ({ page }) => {
  const f = fixtures.get(page)!; f.seed(22);
  let submittedMessage = "";
  f.onSend = async (body) => { submittedMessage = String(body.message); };
  await page.goto("/threads/native-thread");
  await expect(page.getByRole("log").getByText("History request 21", { exact: true })).toBeVisible();
  const viewport = page.locator('[data-slot="thread-viewport"]');
  if (scrolled) await viewport.evaluate((element) => { element.scrollTop = 0; });
  await f.send("Anchor this new turn");
  const user = page.getByRole("log").getByText("Anchor this new turn", { exact: true });
  await expect(user).toBeVisible();
  const thinking = page.getByRole("log").getByText("Thinking", { exact: true }).last();
  await expect(thinking).toBeVisible();
  await expect.poll(async () => (await user.boundingBox())!.y - (await viewport.boundingBox())!.y).toBeLessThan(100);
  const initial = await user.boundingBox();
  const placeholder = await thinking.boundingBox();
  const viewportBox = await viewport.boundingBox();
  expect(initial!.y - viewportBox!.y).toBeLessThan(100);
  expect(placeholder!.y - (initial!.y + initial!.height)).toBeLessThan(110);
  await expect.poll(() => submittedMessage).not.toBe("");
  await f.publish(startTurn(f.cursor, "anchored", "delivery-1", submittedMessage, "history-21"));
  await f.publish(line(f.cursor, { type: "content.delta", scope: { turnId: "anchored", runId: "anchored:run" }, data: {
    partId: "anchored:reply", kind: "text", delta: "Response begins here.",
  } }));
  await expect(page.getByText("Response begins here.", { exact: true })).toBeVisible();
  expect(Math.abs((await user.boundingBox())!.y - initial!.y)).toBeLessThan(8);
  await f.publish(reply(f.cursor, "anchored", "delivery-1", "Response begins here."));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(Math.abs((await user.boundingBox())!.y - initial!.y)).toBeLessThan(8);
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
