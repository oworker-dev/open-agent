import { expect, test, type Page } from "@playwright/test";
const threadStores = new WeakMap<Page, FakeThreadStore>();

test.beforeEach(async ({ page }) => {
  const store: FakeThreadStore = {
    collection: { threads: [], version: 1 },
    revision: 0,
  };
  threadStores.set(page, store);
  await page.route("**/api/standalone/thread-collections/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const requestedThreadId = requestUrl.searchParams.get("threadId");
    if (
      route.request().method() === "GET" &&
      requestedThreadId &&
      requestUrl.searchParams.get("view") !== "index"
    ) {
      await route.fulfill({
        body: JSON.stringify({
          revision: store.revision,
          thread: store.collection.threads.find((thread) => thread.id === requestedThreadId) ?? null,
        }),
        contentType: "application/json",
        headers: { etag: `"${store.revision}"` },
        status: 200,
      });
      return;
    }
    if (route.request().method() === "GET" && requestUrl.searchParams.get("view") === "index") {
      await route.fulfill({
        body: JSON.stringify({
          collection: {
            ...(store.collection.activeThreadId ? { activeThreadId: store.collection.activeThreadId } : {}),
            threads: store.collection.threads.map((thread) => thread.id === requestedThreadId
              ? thread
              : { ...thread, events: [], hydration: "summary" }),
            version: 2,
          },
          revision: store.revision,
        }),
        contentType: "application/json",
        headers: { etag: `"${store.revision}"` },
        status: 200,
      });
      return;
    }
    if (route.request().method() === "PUT" || route.request().method() === "PATCH") {
      if ((store.conflictsRemaining ?? 0) > 0) {
        store.conflictsRemaining = (store.conflictsRemaining ?? 0) - 1;
        store.revision += 1;
        await route.fulfill({
          body: JSON.stringify({ code: "thread_collection_conflict", ok: false }),
          contentType: "application/json",
          headers: { etag: `"${store.revision}"` },
          status: 409,
        });
        return;
      }
      const expected = Number((route.request().headers()["if-match"] ?? "").replaceAll('"', ""));
      if (expected !== store.revision) {
        await route.fulfill({
          body: JSON.stringify({ code: "thread_collection_conflict", ok: false }),
          contentType: "application/json",
          headers: { etag: `"${store.revision}"` },
          status: 409,
        });
        return;
      }
      const body = route.request().postDataJSON() as {
        activeThreadId?: string | null;
        collection?: unknown;
        deletedThreadIds?: readonly string[];
        upsertThreads?: FakeThreadCollection["threads"];
      };
      if (route.request().method() === "PATCH") {
        const deleted = new Set(body.deletedThreadIds ?? []);
        const replacements = new Map((body.upsertThreads ?? []).map((thread) => [thread.id, thread]));
        const retained = store.collection.threads
          .filter((thread) => !deleted.has(thread.id))
          .map((thread) => replacements.get(thread.id) ?? thread);
        const retainedIds = new Set(retained.map((thread) => thread.id));
        store.collection = {
          ...(body.activeThreadId ? { activeThreadId: body.activeThreadId } : {}),
          threads: [
            ...(body.upsertThreads ?? []).filter((thread) => !retainedIds.has(thread.id)),
            ...retained,
          ],
          version: 2,
        };
      } else {
        store.collection = body.collection as FakeThreadCollection;
      }
      store.revision += 1;
    }
    await route.fulfill({
      body: JSON.stringify({ collection: store.collection, revision: store.revision }),
      contentType: "application/json",
      headers: { etag: `"${store.revision}"` },
      status: 200,
    });
  });
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
  await expect(page.locator("aside").getByText("New session", { exact: true })).toHaveCount(2);
  await expect(page.locator('aside [aria-current="page"]')).toHaveCount(1);

  await page.getByRole("button", { name: "Search sessions" }).click();
  await page.getByPlaceholder("Search session history").fill("missing session");
  await expect(page.getByText("No matching sessions")).toBeVisible();

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

test("composer clears immediately while a turn is still being accepted", async ({ page }) => {
  await page.route("**/eve/v1/session", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({
      body: JSON.stringify({ sessionId: "slow-session" }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/eve/v1/session/slow-session/stream**", async (route) => {
    await route.fulfill({
      body: mockSuccessfulTurn("A delayed request", "Accepted."),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("A delayed request");
  await composer.press("Enter");
  await expect(composer).toHaveText("", { timeout: 300 });
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  await expect(page.getByRole("log").getByText("A delayed request", { exact: true })).toBeVisible({ timeout: 300 });
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible({ timeout: 5_000 });
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

test("the thread index hydrates only the transcript selected from the sidebar", async ({ page }) => {
  const now = Date.now();
  const events = mockSuccessfulTurn("Stored request", "Stored response")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  setFakeThreadCollection(page, {
    activeThreadId: "stored-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: now,
      events,
      id: "stored-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId: "stored-session", streamIndex: events.length },
      status: "ready",
      title: "Stored history",
      updatedAt: now,
    }],
    version: 2,
  });
  const transcriptRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/thread-collections/") && url.searchParams.get("threadId")) {
      transcriptRequests.push(url.search);
    }
  });

  await page.goto("/");
  await expect(page.getByText("Stored response", { exact: true })).toHaveCount(0);
  await page.locator("aside").getByRole("button", { name: /Stored history/ }).click();
  await expect(page.getByText("Stored response", { exact: true })).toBeVisible();
  expect(transcriptRequests.filter((search) => !search.includes("view=index"))).toHaveLength(1);
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

test("a collection conflict reloads, merges, and retries without a permanent warning", async ({ page }) => {
  const sessionId = "storage-conflict-session";
  await page.route("**/eve/v1/session", (route) => route.fulfill({
    body: JSON.stringify({ sessionId }),
    contentType: "application/json",
    status: 200,
  }));
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, (route) => route.fulfill({
    body: mockSuccessfulTurn("Persist after conflict", "Saved."),
    contentType: "application/x-ndjson",
    status: 200,
  }));
  await page.goto("/");
  await page.waitForTimeout(350);
  const store = threadStores.get(page)!;
  store.conflictsRemaining = 1;
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Persist after conflict");
  await composer.press("Enter");
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect.poll(() => store.collection.threads.length).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: /could not be saved/i })).toHaveCount(0);
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
  await expect(modelDialog.locator('[data-slot="model-selector-item-name"]').first()).toHaveCSS("font-size", "13px");
  await expect(effortName).toHaveCSS("font-size", "13px");
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

test.describe("touch workspace", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("mobile composer stays bottom-anchored after sending and context opens on tap", async ({ page }) => {
    const sessionId = "mobile-composer-session";
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/eve/v1/session", (route) => route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 200,
    }));
    await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.fulfill({
        body: mockSuccessfulTurn("Hello", "Hello back."),
        contentType: "application/x-ndjson",
        status: 200,
      });
    });

    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Do anything" });
    await composer.fill("Hello");
    await composer.press("Enter");
    await page.setViewportSize({ height: 500, width: 390 });

    const composerFrame = page.locator("form").filter({ has: composer });
    await expect(composerFrame).toBeVisible();
    await expect.poll(async () => {
      const box = await composerFrame.boundingBox();
      return box ? 500 - box.y - box.height : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(20);

    await page.getByRole("button", { name: "Context" }).tap();
    await expect(page.locator('[data-slot="context-display-popover"]')).toBeVisible();
    const contextBox = await page.getByRole("button", { name: "Context" }).boundingBox();
    const actionBox = await page.getByRole("button", { name: /^(?:Send|Cancel)$/ }).boundingBox();
    expect(contextBox?.height).toBeGreaterThanOrEqual(36);
    expect(actionBox?.height).toBeGreaterThanOrEqual(36);
  });

});

test("a real conversation survives refresh and continues with the latest token", async ({ page }) => {
  test.skip(process.env.RUN_AGENT_LIVE_E2E !== "1", "Requires a healthy live model provider.");
  test.setTimeout(9 * 60_000);
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });

  await composer.fill("Reply with exactly: web agent ready");
  await composer.press("Enter");
  await expect(page.getByText("web agent ready", { exact: true })).toBeVisible({ timeout: 4 * 60_000 });
  await page.getByRole("button", { name: "Context" }).hover();
  const contextTooltip = page.getByRole("tooltip");
  await expect(contextTooltip).toContainText("Context usage");
  await expect(contextTooltip).toContainText("Input");
  await expect(contextTooltip).toContainText("Output");

  await page.reload();
  await expect(page.getByText("web agent ready", { exact: true })).toBeVisible();
  await composer.fill("Now reply exactly: continuation works");
  await composer.press("Enter");
  await expect(page.getByText("continuation works", { exact: true })).toBeVisible({ timeout: 4 * 60_000 });
});

test("tool work collapses into one timed execution cycle and keeps the final delivery visible", async ({ page }) => {
  const sessionId = "mock-tool-cycle-session";
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await route.fulfill({
      body: mockToolTurn("Build a website", "The website is ready."),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Build a website");
  await composer.press("Enter");

  const execution = page.getByRole("button", { name: /Worked for/u });
  await expect(execution).toBeVisible();
  await expect(page.getByText("The website is ready.", { exact: true })).toBeVisible();
  await expect(page.getByText("Inspecting the workspace.", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Context" })).not.toContainText("0%");

  await execution.click();
  await expect(page.getByText("Inspecting the workspace.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /(?:Ran|Running) 1 tool/u }).click();
  await expect(page.getByRole("button", { name: /Terminal command/u })).toBeVisible();
  await expect(page.getByText(/exitCode/u)).toHaveCount(0);
  await expect(page.locator('[data-slot="tool-group-root"][data-variant="ghost"]')).toBeVisible();
});

test("ask_question renders a localized question card instead of raw tool JSON", async ({ page }) => {
  const sessionId = "mock-question-session";
  let inputResponseBody: unknown;
  let streamCalls = 0;
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    const body = route.request().postDataJSON();
    if (body.inputResponses) inputResponseBody = body;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamCalls += 1;
    await route.fulfill({
      body: streamCalls === 1 ? mockQuestionTurn() : mockContinuationTurn("继续新的需求", "已进入新的请求。"),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "简体中文" }).click();
  await page.keyboard.press("Escape");

  const composer = page.getByRole("textbox", { name: "做点什么" });
  await composer.fill("帮我确定网站的视觉方向");
  await composer.press("Enter");

  const question = page.locator('[data-input-request-kind="question"]');
  await expect(question).toBeVisible();
  await expect(question.getByText("Agent 需要确认", { exact: true })).toBeVisible();
  await expect(question.getByRole("paragraph").filter({ hasText: "你更喜欢哪种视觉方向？" })).toBeVisible();
  await expect(question.locator('[data-slot="questionnaire-choices"]')).toHaveCSS("display", "flex");
  await expect(question.locator('[data-slot="questionnaire-choice"]:not(.hidden)')).toHaveCount(3);
  await expect(question.getByText("极简现代", { exact: true })).toBeVisible();
  await expect(question.getByText("留白充足，突出品牌内容", { exact: true })).toBeVisible();
  const supplementary = question.getByRole("textbox", { name: "补充信息" });
  await expect(supplementary).toBeEditable();
  await expect(question.getByRole("button", { name: /等待确认/u })).toBeVisible();
  await question.getByRole("radio", { name: /极简现代/u }).click();
  await page.waitForTimeout(100);
  expect(inputResponseBody).toBeUndefined();
  await supplementary.fill("同时保持温暖的品牌语气");
  expect(inputResponseBody).toBeUndefined();
  await question.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(() => inputResponseBody).toMatchObject({
    inputResponses: [{
      optionId: "minimal",
      requestId: "call-question",
      text: "同时保持温暖的品牌语气",
    }],
  });
  await expect(question.getByText("参数", { exact: true })).toHaveCount(0);
  await expect(question.getByText(/allowFreeform|optionId|requestId/u)).toHaveCount(0);
  await expect(page.getByText("正在运行 1 个工具", { exact: true })).toHaveCount(0);
  await expect(composer).toBeEditable();
  await page.screenshot({ path: "/tmp/open-agent-ask-question.png" });
});

test("a normal composer message bypasses a pending Agent question", async ({ page }) => {
  const sessionId = "mock-question-bypass-session";
  let followUpBody: unknown;
  let streamCalls = 0;
  await page.route("**/eve/v1/session", (route) => route.fulfill({
    body: JSON.stringify({ sessionId }),
    contentType: "application/json",
    headers: { "x-eve-session-id": sessionId },
    status: 200,
  }));
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    followUpBody = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamCalls += 1;
    await route.fulfill({
      body: streamCalls === 1 ? mockQuestionTurn() : mockContinuationTurn("继续新的需求", "已进入新的请求。"),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Help me choose a visual direction");
  await composer.press("Enter");
  const question = page.locator('[data-input-request-kind="question"]');
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Close", exact: true }).click();
  const closedTrigger = question.getByRole("button", { name: /Closed/u });
  await expect(closedTrigger).toBeVisible();
  await expect(question.getByText("极简现代", { exact: true })).toBeHidden();
  await closedTrigger.click();
  await expect(question.getByText("极简现代", { exact: true })).toBeVisible();
  await expect(question.getByText("No additional information provided.", { exact: true })).toBeVisible();
  expect(followUpBody).toBeUndefined();
  await composer.fill("Ignore that question and create the content plan first");
  await composer.press("Enter");
  await expect.poll(() => followUpBody).toMatchObject({
    message: "Ignore that question and create the content plan first",
  });
  expect(followUpBody).not.toMatchObject({ inputResponses: expect.anything() });
  await page.getByRole("button", { name: /Worked for/u }).first().click();
  await expect(question.getByRole("button", { name: /Closed/u })).toBeVisible();
});

test("assistant content keeps markdown, reasoning state, and action affordances", async ({ page }) => {
  const sessionId = "mock-rich-message-session";
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await route.fulfill({
      body: mockReasoningMarkdownTurn(),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Explain the result");
  await composer.press("Enter");

  await expect(page.getByRole("heading", { name: "Result", exact: true, level: 2 })).toBeVisible();
  await expect(page.locator(".aui-md-ul")).toHaveCSS("list-style-type", "disc");
  await expect(page.locator(".aui-md-pre")).toContainText("const ready = true;");
  await expect(page.getByRole("button", { name: /Reasoning complete/u })).toBeVisible();
  await expect(page.getByText("Reasoning", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);

  const userMessage = page.getByRole("log").getByText("Explain the result", { exact: true });
  await userMessage.hover();
  await expect(page.getByRole("button", { name: "Edit message" })).toBeVisible();
});

for (const editScenario of [
  {
    editedReply: "Edited delivery.",
    editedRequest: "Edited request",
    label: "changed content",
    sessionId: "mock-edit-changed-session",
  },
  {
    editedReply: "Repeated delivery.",
    editedRequest: "Original request",
    label: "unchanged content",
    sessionId: "mock-edit-unchanged-session",
  },
] as const) {
test(`editing the latest user turn with ${editScenario.label} waits for clear and resends on the same session`, async ({ page }) => {
  const { editedReply, editedRequest, sessionId } = editScenario;
  let streamCalls = 0;
  let clearCalls = 0;
  let clearBoundaryPending = false;
  let clearStreamStartIndex = -1;
  const resendStreamStartIndexes: number[] = [];
  let turnCalls = 0;
  let releaseClear: (() => void) | undefined;
  let releaseEditedStream: (() => void) | undefined;
  const clearMayComplete = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const editedStreamMayComplete = new Promise<void>((resolve) => {
    releaseEditedStream = resolve;
  });
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/clear`, async (route) => {
    clearCalls += 1;
    clearBoundaryPending = true;
    await clearMayComplete;
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    turnCalls += 1;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamCalls += 1;
    const url = new URL(route.request().url());
    if (clearBoundaryPending && !url.searchParams.has("includeTailIndex")) {
      clearBoundaryPending = false;
      clearStreamStartIndex = Number(url.searchParams.get("startIndex") ?? "0");
      const at = new Date().toISOString();
      await route.fulfill({
        body: `${[
          { data: { sequence: 1, sessionId, turnId: "clear_1" }, meta: { at }, type: "context.cleared" },
          { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
        ].map((event) => JSON.stringify(event)).join("\n")}\n`,
        contentType: "application/x-ndjson",
        status: 200,
      });
      return;
    }
    if (url.searchParams.get("startIndex") === "-1") {
      const at = new Date().toISOString();
      await route.fulfill({
        body: `${JSON.stringify({ data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" })}\n`,
        contentType: "application/x-ndjson",
        status: 200,
      });
      return;
    }
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    if (turnCalls > 0) resendStreamStartIndexes.push(startIndex);
    if (turnCalls > 0) await editedStreamMayComplete;
    const body = startIndex === 0
      ? mockSuccessfulTurn("Original request", "Original delivery.")
      : mockContinuationTurn(editedRequest, editedReply, 1);
    await route.fulfill({
      body,
      contentType: "application/x-ndjson",
      ...(url.searchParams.has("includeTailIndex")
        ? { headers: { "x-eve-stream-tail-index": String(startIndex + eventsFromNdjson(body).length - 1) } }
        : {}),
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Original request");
  await composer.press("Enter");
  await expect(page.getByText("Original delivery.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(1);

  const original = page.getByRole("log").getByText("Original request", { exact: true });
  await original.hover();
  await page.getByRole("button", { name: "Edit message" }).click();
  const editComposer = page.locator("[data-agent-edit-composer]");
  const editInput = editComposer.getByRole("textbox");
  await expect(editInput).toBeVisible();
  await expect(editInput).toHaveValue("Original request");
  if (editedRequest !== "Original request") {
    await editInput.fill("");
    await editInput.pressSequentially(editedRequest);
  }
  await editComposer.getByRole("button", { name: "Send", exact: true }).click();

  // The visible revision changes atomically; Eve's clear/rebuild transport may
  // continue in the background without making the edited message disappear.
  await expect(page.getByRole("log").getByText(editedRequest, { exact: true })).toBeVisible({ timeout: 300 });
  await expect(page.getByRole("log").getByText("Original delivery.", { exact: true })).toHaveCount(0);
  releaseClear?.();
  await expect.poll(() => turnCalls).toBe(1);
  await page.waitForTimeout(250);
  await expect(page.getByRole("log").getByText(editedRequest, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: editedRequest, exact: true })).toBeVisible();
  releaseEditedStream?.();
  await expect(page.getByText(editedReply, { exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText("Original delivery.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("log").getByText(editedRequest, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: editedRequest, exact: true })).toBeVisible();
  await expect.poll(() => clearCalls).toBe(1);
  await page.waitForTimeout(250);
  expect(clearCalls).toBe(1);
  expect(resendStreamStartIndexes).toContain(clearStreamStartIndex + 2);
  expect(turnCalls).toBe(1);
  expect(streamCalls).toBeGreaterThanOrEqual(2);
});
}

test("file patch tools render with the assistant-ui diff viewer", async ({ page }) => {
  const sessionId = "mock-patch-viewer-session";
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-export const ready = false;",
    "+export const ready = true;",
  ].join("\n");
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await route.fulfill({
      body: mockToolTurn("Update the application", "The patch is applied.", {
        input: { patch },
        output: "Done",
        toolName: "apply_patch",
      }),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Update the application");
  await composer.press("Enter");
  await page.getByRole("button", { name: /Worked for/u }).click();
  await page.getByRole("button", { name: /(?:Ran|Running) 1 tool/u }).click();
  await page.getByRole("button", { name: /Edited src\/app\.ts \+1 -1/u }).click();

  const diffViewer = page.locator('[data-tool-view="diff"] [data-slot="diff-viewer"]');
  await expect(diffViewer).toBeVisible();
  await expect(diffViewer).toContainText("export const ready = true;");
});

test("a live autonomous website task survives refresh and publishes a usable preview", async ({ page }) => {
  test.skip(process.env.RUN_AGENT_AUTONOMY_E2E !== "1", "Requires a healthy live model provider and sandbox.");
  test.setTimeout(20 * 60_000);
  await page.unroute("**/api/standalone/thread-collections/**");
  await page.goto("/");

  const prompt = [
    "Build a polished responsive one-page enterprise website for Aperture Systems in the sandbox.",
    "Include a navigation bar, a strong hero, three product capabilities, customer proof, and a contact call to action.",
    "Use plain HTML, CSS, and JavaScript, validate the result, then publish it with the website preview tool.",
    "Work autonomously and finish by giving me the working preview link.",
  ].join(" ");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await page.getByRole("button", { name: "Approval mode" }).click();
  await page.getByRole("menuitemradio").filter({ hasText: "Full access" }).click();
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(composer).toHaveText("", { timeout: 1_000 });
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/u);
  const threadUrl = page.url();

  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(page.url()).toBe(threadUrl);
  await expect(page.getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 });

  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 18 * 60_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  const previewLink = page.locator('a[href*="/api/previews/"]').last();
  await expect(previewLink).toBeVisible();
  const href = await previewLink.getAttribute("href");
  expect(href).toBeTruthy();
  const published = new URL(href!, page.url());
  const localPreview = new URL(`${published.pathname}${published.search}`, "http://127.0.0.1:3000");
  const previewPage = await page.context().newPage();
  const previewResponses: Array<{ readonly status: number; readonly url: string }> = [];
  previewPage.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith(`/api/previews/${encodeURIComponent(previewToolId(published))}/`)) {
      previewResponses.push({ status: response.status(), url: response.url() });
    }
  });
  const response = await previewPage.goto(localPreview.toString(), { waitUntil: "networkidle" });
  expect(response?.ok()).toBeTruthy();
  expect((await previewPage.locator("body").innerText()).toLowerCase()).toContain("aperture systems");
  expect(previewResponses.some(({ url }) => new URL(url).pathname.endsWith(".css"))).toBeTruthy();
  expect(previewResponses.some(({ url }) => new URL(url).pathname.endsWith(".js"))).toBeTruthy();
  expect(previewResponses.filter(({ status }) => status >= 400)).toEqual([]);
  await previewPage.close();
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

function previewToolId(url: URL): string {
  const match = /^\/api\/previews\/([^/]+)\//u.exec(url.pathname);
  if (!match?.[1]) throw new Error("The preview URL does not contain a preview id.");
  return decodeURIComponent(match[1]);
}

test("a transport failure preserves the original request without inventing a continuation prompt", async ({ page }) => {
  await page.route("**/eve/v1/session", async (route) => {
    await route.abort("connectionfailed");
  });
  await page.goto("/");

  const composer = page.getByRole("textbox", { name: "Do anything" });
  const original = "Build the enterprise website and publish a preview";
  await composer.fill(original);
  await composer.press("Enter");
  await expect(page.getByText("This turn failed")).toBeVisible();
  await expect(page.getByText(original, { exact: true })).toBeVisible();
  await expect(page.getByText("Your original request is preserved in this session.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible();
});

test("a slow Provider does not force the live Agent stream into recovery", async ({ page }) => {
  const sessionId = "mock-slow-provider-session";
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await route.fulfill({
      body: mockSuccessfulTurn("Run a slow task", "Slow task completed."),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Run a slow task");
  await composer.press("Enter");
  await expect(composer).toBeEnabled();
  const activity = page.getByRole("status").filter({ hasText: "Thinking" });
  await expect(activity).toBeVisible();
  await expect(activity).toHaveText("Thinking");
  await page.waitForTimeout(8_500);
  await expect(page.getByText("Reconnecting to the active run...")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible();
  await expect(page.getByText("Slow task completed.", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeEnabled();
});

test("a follow-up is admitted into the active turn at the next model boundary", async ({ page }) => {
  const sessionId = "mock-follow-up-session";
  let continuationRequests = 0;
  let continuationAvailable = false;
  let mailboxBody: Record<string, unknown> | undefined;
  let mailboxRequests = 0;
  const initialEvents = eventsFromNdjson(
    mockToolTurn("Start the long task", "Unused terminal reply."),
  ).slice(0, 8);

  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    continuationRequests += 1;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route("**/api/standalone/mailbox", async (route) => {
    mailboxRequests += 1;
    mailboxBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: mailboxBody.clientMessageId,
          itemId: "mail-follow-up",
          status: "queued",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route("**/api/standalone/mailbox/mail-follow-up", async (route) => {
    continuationAvailable = true;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: mailboxBody?.clientMessageId ?? "unknown-client-message",
          itemId: "mail-follow-up",
          status: "accepted",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    if (startIndex === 0) {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.fulfill({
        body: ndjson(initialEvents),
        contentType: "application/x-ndjson",
        headers: { "x-eve-stream-tail-index": String(initialEvents.length - 1) },
        status: 200,
      });
      return;
    }
    const availableEvents = continuationAvailable
      ? [
          ...initialEvents,
          ...mockSteeredTurnRemainder(
            "turn_tool",
            mailboxBody?.clientMessageId,
            "Add the requested footer",
            "Footer added.",
          ),
        ]
      : initialEvents;
    await route.fulfill({
      body: ndjson(availableEvents.slice(startIndex)),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(availableEvents.length - 1) },
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Start the long task");
  await composer.press("Enter");
  await expect(composer).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await composer.fill("Add the requested footer");
  await expect(page.getByRole("button", { name: "Queue follow-up" })).toBeVisible();
  await composer.press("Enter");

  await expect(page.locator("[data-agent-steer-queue]")).toContainText("Queued follow-ups");
  await expect(page.getByText("Add the requested footer", { exact: true })).toBeVisible();
  await expect(page.getByText("Footer added.", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  expect(continuationRequests).toBe(0);
  expect(mailboxRequests).toBe(1);
  expect(mailboxBody).toMatchObject({
    message: "Add the requested footer",
    sessionId,
  });
});

test("cancelling a queued follow-up prevents browser delivery before admission", async ({ page }) => {
  const sessionId = "mock-cancel-follow-up-session";
  let cancellationRequests = 0;
  let continuationRequests = 0;
  let mailboxEnqueues = 0;
  let mailboxInspections = 0;

  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    continuationRequests += 1;
    await route.fulfill({ status: 500 });
  });
  await page.route("**/api/standalone/mailbox", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: body.clientMessageId,
          itemId: "mail-cancel-follow-up",
          status: "queued",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 202,
    });
    mailboxEnqueues += 1;
  });
  await page.route("**/api/standalone/mailbox/mail-cancel-follow-up", async (route) => {
    const cancelled = route.request().method() === "DELETE";
    if (cancelled) cancellationRequests += 1;
    else mailboxInspections += 1;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: "queued-cancel-follow-up",
          itemId: "mail-cancel-follow-up",
          status: cancelled ? "cancelled" : "queued",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.fulfill({
      body: mockSuccessfulTurn("Start cancellable work", "Cancellable work completed."),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Start cancellable work");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await composer.fill("Do not deliver this follow-up");
  await expect(page.getByRole("button", { name: "Queue follow-up" })).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveText("");
  await expect(page.getByText("Do not deliver this follow-up", { exact: true })).toBeVisible();
  await expect.poll(() => mailboxEnqueues).toBe(1);
  await expect.poll(() => mailboxInspections).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Remove queued message" }).click();
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  await expect(page.getByText("Cancellable work completed.", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(cancellationRequests).toBe(1);
  expect(continuationRequests).toBe(0);
});

test("stopping an active turn restores an unadmitted durable follow-up to the composer", async ({ page }) => {
  const sessionId = "mock-stop-restores-follow-up-session";
  const itemId = "mail-stop-restores-follow-up";
  const at = new Date().toISOString();
  const turnId = "turn_0";
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Start long work", parts: [{ text: "Start long work", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.cancelled" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  let clientMessageId = "";
  let mailboxCancelled = false;
  let turnCancellationAccepted = false;

  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route("**/api/standalone/mailbox", async (route) => {
    const body = route.request().postDataJSON() as { clientMessageId: string };
    clientMessageId = body.clientMessageId;
    await route.fulfill({
      body: JSON.stringify({
        item: { clientMessageId, itemId, status: "queued" },
        ok: true,
      }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/api/standalone/mailbox/${itemId}`, async (route) => {
    if (route.request().method() === "DELETE") mailboxCancelled = true;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId,
          itemId,
          status: mailboxCancelled ? "cancelled" : "queued",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/cancel`, async (route) => {
    turnCancellationAccepted = true;
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    const visibleEvents = startIndex === 0
      ? events.slice(0, 3)
      : turnCancellationAccepted
        ? events.slice(startIndex)
        : [];
    await route.fulfill({
      body: ndjson(visibleEvents),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(events.length - 1) },
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Start long work");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await composer.fill("Use the blue variant instead");
  await composer.press("Enter");
  await expect(page.getByText("Use the blue variant instead", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  await expect.poll(() => mailboxCancelled).toBeTruthy();
  await expect(composer).toHaveText("Use the blue variant instead");
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
});

test("a mailbox cancellation race reconciles committed admission without a stale cancel error", async ({ page }) => {
  const sessionId = "mock-mailbox-cancel-race-session";
  const clientMessageId = "queued-mailbox-cancel-race";
  const itemId = "mailbox-cancel-race";
  const settledEvents = eventsFromNdjson(mockSuccessfulTurn("Prepare mailbox race", "Ready."));
  const admittedEvents = withClientMessageId(
    eventsFromNdjson(mockContinuationTurn("Committed follow-up", "Committed follow-up completed.")),
    clientMessageId,
  ).map((event, index) => isRecord(event) && isRecord(event.meta)
    ? { ...event, meta: { ...event.meta, id: `evt-mailbox-cancel-race-${index}` } }
    : event);
  let cancelAttempted = false;
  let mailboxInspections = 0;
  let releaseAdmission: (() => void) | undefined;
  const admissionReleased = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });

  setFakeThreadCollection(page, {
    activeThreadId: "mailbox-cancel-race-thread",
    threads: [{
      createdAt: Date.now(),
      events: settledEvents,
      id: "mailbox-cancel-race-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [{
        delivery: "server",
        id: clientMessageId,
        intent: "active-turn",
        mailboxItemId: itemId,
        state: "queued",
        submittedAt: Date.now(),
        text: "Committed follow-up",
      }],
      session: { sessionId, streamIndex: settledEvents.length },
      status: "ready",
      title: "Mailbox cancellation race",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/api/standalone/mailbox/${itemId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      cancelAttempted = true;
      await route.fulfill({
        body: JSON.stringify({
          code: "mailbox_item_not_cancellable",
          error: "This mailbox item can no longer be cancelled.",
          ok: false,
        }),
        contentType: "application/json",
        status: 409,
      });
      return;
    }
    mailboxInspections += 1;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId,
          itemId,
          status: cancelAttempted ? "committed" : "queued",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await admissionReleased;
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    const events = startIndex <= settledEvents.length ? admittedEvents : [];
    await route.fulfill({
      body: ndjson(events),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(settledEvents.length + admittedEvents.length - 1) },
      status: 200,
    });
  });

  await page.goto("/threads/mailbox-cancel-race-thread");
  await page.getByRole("button", { name: "Remove queued message" }).click();
  await expect.poll(() => cancelAttempted).toBeTruthy();
  await expect(page.getByText("This mailbox item can no longer be cancelled.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove queued message" })).toHaveCount(0);

  releaseAdmission?.();
  await expect(page.getByText("Committed follow-up completed.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  expect(mailboxInspections).toBeLessThanOrEqual(5);
});

test("a committed normal-turn mailbox message without a client id clears after transcript catch-up", async ({ page }) => {
  const sessionId = "mock-committed-normal-turn-session";
  const threadId = "committed-normal-turn-thread";
  const clientMessageId = "queued-committed-normal-turn";
  const itemId = "mail-committed-normal-turn";
  const settledEvents = eventsFromNdjson(mockSuccessfulTurn("Prepare committed delivery", "Ready."));
  const admittedEvents = eventsFromNdjson(
    mockContinuationTurn("Continue without a client id", "Committed delivery completed."),
  );
  let streamRequests = 0;

  setFakeThreadCollection(page, {
    activeThreadId: threadId,
    threads: [{
      createdAt: Date.now() - 2_000,
      events: settledEvents,
      id: threadId,
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [{
        delivery: "server",
        id: clientMessageId,
        intent: "active-turn",
        mailboxItemId: itemId,
        state: "committed",
        submittedAt: Date.now() - 1_000,
        text: "Continue without a client id",
      }],
      session: { sessionId, streamIndex: settledEvents.length },
      status: "streaming",
      title: "Committed normal turn",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/api/standalone/mailbox/${itemId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        item: { clientMessageId, itemId, status: "committed" },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamRequests += 1;
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    const events = startIndex <= settledEvents.length ? admittedEvents : [];
    await route.fulfill({
      body: ndjson(events),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(settledEvents.length + admittedEvents.length - 1) },
      status: 200,
    });
  });

  await page.goto(`/threads/${threadId}`);

  await expect(page.getByText("Committed delivery completed.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(streamRequests).toBeLessThanOrEqual(4);
});

test("a persisted follow-up survives recovery and dispatches after the durable boundary", async ({ page }) => {
  const sessionId = "mock-persisted-follow-up-session";
  const initialTurn = eventsFromNdjson(mockSuccessfulTurn("Start persisted work", "Persisted work completed."));
  const acceptedEvents = initialTurn.slice(0, 4);
  let continuationRequests = 0;
  let mailboxEnqueues = 0;

  setFakeThreadCollection(page, {
    activeThreadId: "persisted-follow-up-thread",
    threads: [{
      createdAt: Date.now(),
      events: acceptedEvents,
      id: "persisted-follow-up-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [{
        delivery: "server",
        id: "queued-persisted-footer",
        mailboxItemId: "mail-persisted-footer",
        state: "queued",
        submittedAt: Date.now(),
        text: "Add the persisted footer",
      }],
      session: { sessionId, streamIndex: acceptedEvents.length },
      status: "streaming",
      title: "Persisted follow-up",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    continuationRequests += 1;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/standalone/mailbox", async (route) => {
    mailboxEnqueues += 1;
    await route.fulfill({ status: 500 });
  });
  await page.route("**/api/standalone/mailbox/mail-persisted-footer", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: "queued-persisted-footer",
          itemId: "mail-persisted-footer",
          status: "accepted",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    if (startIndex < initialTurn.length) {
      await route.fulfill({
        body: `${initialTurn.slice(startIndex).map((event) => JSON.stringify(event)).join("\n")}\n`,
        contentType: "application/x-ndjson",
        headers: { "x-eve-stream-tail-index": String(initialTurn.length - 1) },
        status: 200,
      });
      return;
    }
    const continuationEvents = withClientMessageId(
      eventsFromNdjson(
        mockContinuationTurn("Add the persisted footer", "Persisted footer added."),
      ),
      "queued-persisted-footer",
    );
    await route.fulfill({
      body: ndjson(continuationEvents),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(startIndex + continuationEvents.length - 1) },
      status: 200,
    });
  });

  await page.goto("/threads/persisted-follow-up-thread");
  await expect(page.getByText("Persisted footer added.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  expect(continuationRequests).toBe(0);
  expect(mailboxEnqueues).toBe(0);
});

test("two persisted follow-ups remain separate and recover in strict FIFO order", async ({ page }) => {
  const sessionId = "mock-fifo-follow-up-session";
  const initialEvents = eventsFromNdjson(mockSuccessfulTurn("Prepare the workspace", "Workspace prepared."));
  const firstEvents = withClientMessageId(
    eventsFromNdjson(mockContinuationTurn("Add the header", "Header added.", 1)),
    "queued-fifo-header",
  ).map((event, index) => isRecord(event) && isRecord(event.meta)
    ? { ...event, meta: { ...event.meta, id: `evt-fifo-header-${index}` } }
    : event);
  const secondEvents = withClientMessageId(
    eventsFromNdjson(mockContinuationTurn("Add the footer", "Footer added.", 2)),
    "queued-fifo-footer",
  ).map((event, index) => isRecord(event) && isRecord(event.meta)
    ? { ...event, meta: { ...event.meta, id: `evt-fifo-footer-${index}` } }
    : event);
  const firstCursor = initialEvents.length;
  const secondCursor = firstCursor + firstEvents.length;
  let continuationRequests = 0;
  const mailboxInspections: string[] = [];

  setFakeThreadCollection(page, {
    activeThreadId: "fifo-follow-up-thread",
    threads: [{
      createdAt: Date.now(),
      events: initialEvents,
      id: "fifo-follow-up-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [
        {
          delivery: "server",
          id: "queued-fifo-header",
          mailboxItemId: "mail-fifo-header",
          state: "queued",
          submittedAt: Date.now(),
          text: "Add the header",
        },
        {
          delivery: "server",
          id: "queued-fifo-footer",
          mailboxItemId: "mail-fifo-footer",
          state: "queued",
          submittedAt: Date.now() + 1,
          text: "Add the footer",
        },
      ],
      session: {
        sessionId,
        streamIndex: firstCursor,
      },
      status: "ready",
      title: "FIFO follow-ups",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    continuationRequests += 1;
    await route.fulfill({ status: 500 });
  });
  for (const [itemId, clientMessageId] of [
    ["mail-fifo-header", "queued-fifo-header"],
    ["mail-fifo-footer", "queued-fifo-footer"],
  ] as const) {
    await page.route(`**/api/standalone/mailbox/${itemId}`, async (route) => {
      mailboxInspections.push(itemId);
      await route.fulfill({
        body: JSON.stringify({
          item: { clientMessageId, itemId, status: "committed" },
          ok: true,
        }),
        contentType: "application/json",
        status: 200,
      });
    });
  }
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    const body = startIndex < secondCursor
      ? `${firstEvents.slice(Math.max(0, startIndex - firstCursor)).map((event) => JSON.stringify(event)).join("\n")}\n`
      : `${secondEvents.slice(Math.max(0, startIndex - secondCursor)).map((event) => JSON.stringify(event)).join("\n")}\n`;
    const eventCount = eventsFromNdjson(body).length;
    await route.fulfill({
      body,
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(startIndex + eventCount - 1) },
      status: 200,
    });
  });

  await page.goto("/threads/fifo-follow-up-thread");
  await expect(page.getByText("Header added.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Footer added.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();

  await expect.poll(() => threadEvents(page)
    .filter((event) => isEventType(event, "message.received"))
    .map((event) => (event as { data: { message: string } }).data.message)
  ).toEqual(["Prepare the workspace", "Add the header", "Add the footer"]);
  expect(continuationRequests).toBe(0);
  expect(mailboxInspections).toContain("mail-fifo-header");
  expect(mailboxInspections).toContain("mail-fifo-footer");
});

test("a failed queued follow-up remains retryable without duplicating the accepted turn", async ({ page }) => {
  const sessionId = "mock-retry-follow-up-session";
  const settledEvents = eventsFromNdjson(mockSuccessfulTurn("Prepare retry", "Ready for follow-up."));
  let continuationRequests = 0;

  setFakeThreadCollection(page, {
    activeThreadId: "retry-follow-up-thread",
    threads: [{
      createdAt: Date.now(),
      events: settledEvents,
      id: "retry-follow-up-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [{
        delivery: "server",
        id: "queued-retry-footer",
        mailboxItemId: "mail-retry-footer",
        state: "delivery-failed",
        submittedAt: Date.now(),
        text: "Retry the footer",
      }],
      session: {
        sessionId,
        streamIndex: settledEvents.length,
      },
      status: "ready",
      title: "Retry follow-up",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    continuationRequests += 1;
    if (continuationRequests === 1) {
      await route.abort("connectionfailed");
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/standalone/mailbox/mail-retry-footer", async (route) => {
    if (route.request().method() !== "GET") continuationRequests += 1;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: "queued-retry-footer",
          itemId: "mail-retry-footer",
          status: route.request().method() === "PATCH" ? "queued" : "accepted",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    const continuationEvents = withClientMessageId(
      eventsFromNdjson(
        mockContinuationTurn("Retry the footer", "Retried footer added."),
      ),
      "queued-retry-footer",
    );
    await route.fulfill({
      body: ndjson(continuationEvents),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(startIndex + continuationEvents.length - 1) },
      status: 200,
    });
  });

  await page.goto("/threads/retry-follow-up-thread");
  await expect(page.getByText("Delivery failed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry queued message" }).click();
  await expect(page.getByText("Retried footer added.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  expect(continuationRequests).toBe(1);
});

test("an ambiguous mailbox admission is visible but never offered as a blind retry", async ({ page }) => {
  const sessionId = "mock-ambiguous-follow-up-session";
  const settledEvents = eventsFromNdjson(mockSuccessfulTurn("Prepare ambiguity", "Ready for follow-up."));

  setFakeThreadCollection(page, {
    activeThreadId: "ambiguous-follow-up-thread",
    threads: [{
      createdAt: Date.now(),
      events: settledEvents,
      id: "ambiguous-follow-up-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [{
        delivery: "server",
        id: "queued-ambiguous-footer",
        mailboxItemId: "mail-ambiguous-footer",
        state: "admission-ambiguous",
        submittedAt: Date.now(),
        text: "The possibly admitted footer",
      }],
      session: { sessionId, streamIndex: settledEvents.length },
      status: "ready",
      title: "Ambiguous follow-up",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route("**/api/standalone/mailbox/mail-ambiguous-footer", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: "queued-ambiguous-footer",
          itemId: "mail-ambiguous-footer",
          lastError: "The admission response was lost.",
          status: "submission-ambiguous",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/threads/ambiguous-follow-up-thread");
  await expect(page.getByText("Admission needs review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry queued message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove queued message" })).toHaveCount(0);
});

test("a proxied child approval stays attached to the parent task and resumes it", async ({ page }) => {
  const sessionId = "mock-child-approval-session";
  const initialEvents = mockChildApprovalEvents();
  let responseBody: unknown;
  setFakeThreadCollection(page, {
    activeThreadId: "child-approval-thread",
    threads: [{
      createdAt: Date.now(),
      events: initialEvents,
      id: "child-approval-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      session: {
        sessionId,
        streamIndex: initialEvents.length,
      },
      status: "waiting",
      title: "Delegated website task",
      updatedAt: Date.now(),
    }],
    version: 1,
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    responseBody = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await route.fulfill({
      body: mockChildApprovalResumeEvents(),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });
  await page.route("**/eve/v1/session/child-css/stream**", async (route) => {
    await route.fulfill({
      body: mockCompletedChildTurn("Build and validate the stylesheet", "Child stylesheet complete."),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/threads/child-approval-thread");
  await expect(page.getByText("Waiting for approval", { exact: true })).toBeVisible();
  await expect(page.getByText("A delegated task needs your approval", { exact: true })).toBeVisible();
  await expect(page.getByText("npm test && rm -f /tmp/css-classes", { exact: true })).toBeVisible();
  const editMessage = page.getByRole("button", { name: "Edit message", exact: true });
  await expect(editMessage).toBeVisible();
  await editMessage.click();
  const editComposer = page.locator("[data-agent-edit-composer]");
  await expect(editComposer).toBeVisible();
  await expect(editComposer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await editComposer.getByRole("button", { name: "Cancel", exact: true }).click();
  const approve = page.getByRole("radio", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeDisabled();

  await approve.click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => responseBody).toMatchObject({
    inputResponses: [{ optionId: "approve", requestId: "request-child-bash" }],
  });
  await expect(page.getByText("The delegated task resumed and completed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Worked for/u })).toHaveCount(1);
  await page.getByRole("button", { name: /Worked for/ }).click();
  await page.getByRole("button", { name: /(?:Ran|Running) 1 tool/u }).click();
  await page.getByRole("button", { name: /Sub-agent/u }).click();
  await expect(page.getByText("Sub-agent finished and returned its result to the parent Agent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open sub-agents" }).click();
  await expect(page.getByRole("region", { name: "Done" }).getByText("Sub-agent 1", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Open sub-agent session/u }).click();
  await expect(page).toHaveURL(/\/threads\/child-approval-thread\/agents\/child-css$/);
  await expect(page.getByText("Child stylesheet complete.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to parent session" }).click();
  await expect(page).toHaveURL(/\/threads\/child-approval-thread$/);
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeEnabled();
});

test("an original page catches up through Eve's native stream reconnect", async ({ page }) => {
  const sessionId = "mock-stalled-browser-session";
  const at = new Date().toISOString();
  const turnId = "turn_0";
  const recoveredEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Run a durable task", parts: [{ text: "Run a durable task", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
    { data: { finishReason: "stop", message: "Durable progress recovered.", sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 1, outputTokens: 1 } }, meta: { at }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  let boundedRequests = 0;
  let liveRequests = 0;

  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("includeTailIndex") !== "1") {
      liveRequests += 1;
      const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
      const acceptedEvents = liveRequests === 1
        ? recoveredEvents.slice(startIndex, 4)
        : recoveredEvents.slice(startIndex);
      await route.fulfill({
        body: acceptedEvents.length > 0
          ? `${acceptedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
          : "",
        contentType: "application/x-ndjson",
        status: 200,
      });
      return;
    }
    boundedRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    await route.fulfill({
      body: `${recoveredEvents.slice(startIndex).map((event) => JSON.stringify(event)).join("\n")}\n`,
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(recoveredEvents.length - 1) },
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Run a durable task");
  await composer.press("Enter");

  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible();
  await expect(page.getByText("Durable progress recovered.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(liveRequests).toBeGreaterThanOrEqual(2);
  expect(boundedRequests).toBe(0);
});

test("a half-open live stream is replaced from the last event observed by the UI", async ({ page }) => {
  test.setTimeout(40_000);
  const sessionId = "mock-half-open-session";
  const at = new Date().toISOString();
  const turnId = "turn_half_open";
  const durableEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at, id: "evt-half-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-half-turn" }, type: "turn.started" },
    { data: { message: "Keep this long task live", parts: [{ text: "Keep this long task live", type: "text" }], sequence: 0, turnId }, meta: { at, id: "evt-half-user" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-half-step-0" }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-half-message-0" }, type: "message.completed" },
    { data: { actions: [{ callId: "call-half", input: { command: "npm test" }, kind: "tool-call", toolName: "bash" }], sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-half-actions" }, type: "actions.requested" },
    {
      data: {
        result: { callId: "call-half", kind: "tool-result", output: "tests passed", toolName: "bash" },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId,
      },
      meta: { at, id: "evt-half-result" },
      type: "action.result",
    },
    { data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 10, outputTokens: 4 } }, meta: { at, id: "evt-half-step-completed-0" }, type: "step.completed" },
    { data: { sequence: 0, stepIndex: 1, turnId }, meta: { at, id: "evt-half-step-1" }, type: "step.started" },
    { data: { finishReason: "stop", message: "Recovered without a page refresh.", sequence: 0, stepIndex: 1, turnId }, meta: { at, id: "evt-half-message-1" }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId, usage: { inputTokens: 12, outputTokens: 5 } }, meta: { at, id: "evt-half-step-completed-1" }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-half-completed" }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at, id: "evt-half-waiting" }, type: "session.waiting" },
  ];

  await page.addInitScript(({ events, targetSessionId }) => {
    const nativeFetch = window.fetch.bind(window);
    let liveRequests = 0;
    window.fetch = async (input, init) => {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        window.location.href,
      );
      if (requestUrl.pathname !== `/eve/v1/session/${targetSessionId}/stream`) {
        return await nativeFetch(input, init);
      }
      const startIndex = Number(requestUrl.searchParams.get("startIndex") ?? "0");
      if (requestUrl.searchParams.get("includeTailIndex") === "1") {
        return new Response(`${events.slice(startIndex).map((event) => JSON.stringify(event)).join("\n")}\n`, {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-stream-tail-index": String(events.length - 1),
          },
          status: 200,
        });
      }
      liveRequests += 1;
      if (liveRequests > 1) {
        return new Response(`${events.slice(startIndex).map((event) => JSON.stringify(event)).join("\n")}\n`, {
          headers: { "content-type": "application/x-ndjson" },
          status: 200,
        });
      }

      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = new ReadableStream({
        start(controller) {
          const prefix = `${events.slice(startIndex, 4).map((event) => JSON.stringify(event)).join("\n")}\n`;
          controller.enqueue(new TextEncoder().encode(prefix));
          signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
        status: 200,
      });
    };
  }, { events: durableEvents, targetSessionId: sessionId });

  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Keep this long task live");
  await composer.press("Enter");

  await expect(page.getByRole("status").filter({ hasText: "Thinking" })).toBeVisible();
  await expect(page.getByText("Recovered without a page refresh.", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect.poll(() => threadEvents(page).some((event) => isEventType(event, "session.waiting"))).toBeTruthy();
});

test("large legacy incremental history hydrates quickly without an eager writeback", async ({ page }) => {
  const at = new Date().toISOString();
  const events = Array.from({ length: 3_000 }, (_, index) => ({
    data: {
      messageDelta: "x",
      messageSoFar: `${String(index).padStart(4, "0")}:${"x".repeat(900)}`,
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_legacy",
    },
    meta: { at },
    type: "message.appended",
  }));
  setFakeThreadCollection(page, {
    activeThreadId: "legacy-thread",
    threads: [{
      createdAt: Date.now(),
      events,
      id: "legacy-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      session: { streamIndex: events.length },
      status: "ready",
      title: "Legacy history",
      updatedAt: Date.now(),
    }],
    version: 1,
  });

  const startedAt = Date.now();
  await page.goto("/threads/legacy-thread");
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeVisible({ timeout: 5_000 });
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  // Opening history is read-only. The in-memory parser compacts the transcript,
  // while the legacy server document is rewritten only with its next real patch.
  expect(threadEvents(page)).toHaveLength(events.length);
});

test("a persisted cursor past a missing UI boundary repairs from the durable tail", async ({ page }) => {
  const sessionId = "mock-missing-boundary-session";
  const at = new Date().toISOString();
  const turnId = "turn_0";
  const projectedEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Repair this thread", parts: [{ text: "Repair this thread", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
  ];
  const waiting = { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" };
  const absoluteTailIndex = 7;

  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("startIndex") === "-1") {
      await route.fulfill({
        body: `${JSON.stringify(waiting)}\n`,
        contentType: "application/x-ndjson",
        status: 200,
      });
      return;
    }
    await route.fulfill({
      body: "",
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(absoluteTailIndex) },
      status: 200,
    });
  });

  const now = Date.now();
  setFakeThreadCollection(page, {
    activeThreadId: "missing-boundary-thread",
    threads: [{
      createdAt: now,
      events: projectedEvents,
      id: "missing-boundary-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      session: { sessionId, streamIndex: absoluteTailIndex + 1 },
      status: "streaming",
      title: "Missing boundary",
      updatedAt: now,
    }],
    version: 1,
  });

  await page.goto("/threads/missing-boundary-thread");
  await expect(page.getByText("Reconnecting to the active run...")).toBeHidden({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect.poll(() => threadEvents(page).some((event) => isEventType(event, "session.waiting"))).toBeTruthy();
});

test("an in-flight turn reconnects after a hard refresh", async ({ page }) => {
  const sessionId = "mock-refresh-session";
  let releaseRecovery: (() => void) | undefined;
  const recoveryReleased = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const at = new Date().toISOString();
  const turnId = "turn_0";
  const acceptedEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Run through refresh", parts: [{ text: "Run through refresh", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
  ];
  const completedEvents = [
    ...acceptedEvents,
    { data: { finishReason: "stop", message: "Refresh recovery ready.", sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 1, outputTokens: 1 } }, meta: { at }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];

  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    if (url.searchParams.get("includeTailIndex") === "1" || startIndex > 0) {
      await recoveryReleased;
      await route.fulfill({
        body: `${completedEvents.slice(startIndex).map((event) => JSON.stringify(event)).join("\n")}\n`,
        contentType: "application/x-ndjson",
        headers: { "x-eve-stream-tail-index": String(completedEvents.length - 1) },
        status: 200,
      });
      return;
    }
    await route.fulfill({
      body: startIndex === 0
        ? `${acceptedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
        : "",
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Run through refresh");
  await composer.press("Enter");
  await expect.poll(() => threadEvents(page).some((event) => isEventType(event, "step.started"))).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Do anything" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  releaseRecovery?.();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Reconnecting to the active run...")).toBeHidden();
  await expect(page.getByText("Refresh recovery ready.", { exact: true })).toBeVisible();
  await expect.poll(() => JSON.stringify(threadEvents(page)).includes('"session.waiting"')).toBeTruthy();
});

test("stop immediately returns the thread to an interactive state while server cancellation settles", async ({ page }) => {
  const sessionId = "mock-cancel-session";
  let finishCancellation: (() => void) | undefined;
  let cancelledTurnId: string | undefined;
  const cancelled = new Promise<void>((resolve) => {
    finishCancellation = resolve;
  });
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/cancel`, async (route) => {
    cancelledTurnId = (route.request().postDataJSON() as { turnId?: string }).turnId;
    await new Promise((resolve) => setTimeout(resolve, 150));
    finishCancellation?.();
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const at = new Date().toISOString();
    const turnId = "turn_0";
    const events = [
      { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
      { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
      { data: { message: "Wait", parts: [{ text: "Wait", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
      { data: { sequence: 0, turnId }, meta: { at }, type: "turn.cancelled" },
      { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
    ];
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    if (startIndex === 0) {
      await route.fulfill({
        body: `${events.slice(0, 3).map((event) => JSON.stringify(event)).join("\n")}\n`,
        contentType: "application/x-ndjson",
        status: 200,
      });
      return;
    }
    await cancelled;
    await route.fulfill({
      body: `${events.slice(startIndex).map((event) => JSON.stringify(event)).join("\n")}\n`,
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(events.length - 1) },
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Wait");
  await composer.press("Enter");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 100 });
  await cancelled;
  expect(cancelledTurnId).toBe("turn_0");
});

test("a message sent while cancellation settles becomes the next normal turn instead of mailbox steering", async ({ page }) => {
  const sessionId = "mock-post-cancel-follow-up-session";
  const at = new Date().toISOString();
  const turnId = "turn_0";
  const initialEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Start long work", parts: [{ text: "Start long work", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
  ];
  const cancelledEvents = [
    ...initialEvents,
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.cancelled" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  const continuationEvents = eventsFromNdjson(
    mockContinuationTurn("Continue as a normal turn", "Normal continuation completed."),
  );
  let releaseCancellation: (() => void) | undefined;
  const cancellationReleased = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let followUpBody: Record<string, unknown> | undefined;
  let mailboxEnqueues = 0;

  await page.route("**/eve/v1/session", (route) => route.fulfill({
    body: JSON.stringify({ sessionId }),
    contentType: "application/json",
    headers: { "x-eve-session-id": sessionId },
    status: 202,
  }));
  await page.route(`**/eve/v1/session/${sessionId}/cancel`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    followUpBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route("**/api/standalone/mailbox", async (route) => {
    mailboxEnqueues += 1;
    await route.fulfill({
      body: JSON.stringify({
        item: {
          clientMessageId: "unexpected-mailbox-message",
          itemId: "unexpected-mailbox-item",
          status: "queued",
        },
        ok: true,
      }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    if (startIndex === 0) {
      await route.fulfill({ body: ndjson(initialEvents), contentType: "application/x-ndjson", status: 200 });
      return;
    }
    await cancellationReleased;
    const events = followUpBody
      ? continuationEvents
      : cancelledEvents.slice(startIndex);
    await route.fulfill({
      body: ndjson(events),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(startIndex + events.length - 1) },
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Start long work");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await composer.fill("Continue as a normal turn");
  await composer.press("Enter");
  await expect(page.getByText("Continue as a normal turn", { exact: true })).toBeVisible();
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  expect(mailboxEnqueues).toBe(0);
  expect(followUpBody).toBeUndefined();

  releaseCancellation?.();
  await expect.poll(() => followUpBody).toMatchObject({ message: "Continue as a normal turn" });
  await expect(page.getByText("Normal continuation completed.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  expect(mailboxEnqueues).toBe(0);
});

test("a post-cancellation message survives a recovery event arriving in the same stream batch", async ({ page }) => {
  const threadId = "mid-batch-post-cancel-thread";
  const sessionId = "mock-mid-batch-post-cancel-session";
  const at = new Date().toISOString();
  const turnId = "turn_0";
  const initialEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Start interrupted work", parts: [{ text: "Start interrupted work", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
  ];
  const cancellationEvents = [
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.cancelled" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  const continuationEvents = eventsFromNdjson(
    mockContinuationTurn("Continue after the boundary", "Boundary continuation completed."),
  );
  let followUpBody: Record<string, unknown> | undefined;

  setFakeThreadCollection(page, {
    activeThreadId: threadId,
    threads: [{
      createdAt: Date.now(),
      events: initialEvents,
      id: threadId,
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: initialEvents.length },
      status: "cancelling",
      title: "Mid-batch cancellation",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.addInitScript(({ boundaryEvents, targetSessionId }) => {
    const nativeFetch = window.fetch.bind(window);
    let intercepted = false;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!intercepted && url.includes(`/eve/v1/session/${targetSessionId}/stream`)) {
        intercepted = true;
        const encoder = new TextEncoder();
        let releaseBoundary: (() => void) | undefined;
        const boundaryReleased = new Promise<void>((resolve) => {
          releaseBoundary = resolve;
        });
        Reflect.set(window, "__openAgentReleaseRecoveryBoundary", releaseBoundary);
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify(boundaryEvents[0])}\n`));
            Reflect.set(window, "__openAgentRecoveryMidBatch", true);
            await boundaryReleased;
            controller.enqueue(encoder.encode(`${JSON.stringify(boundaryEvents[1])}\n`));
            controller.close();
          },
        }), {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-stream-tail-index": "4",
          },
          status: 200,
        });
      }
      return nativeFetch(input, init);
    };
  }, { boundaryEvents: cancellationEvents, targetSessionId: sessionId });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    followUpBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    const events = followUpBody ? continuationEvents : [];
    await route.fulfill({
      body: ndjson(events),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(startIndex + events.length - 1) },
      status: 200,
    });
  });

  await page.goto(`/threads/${threadId}`);
  await page.waitForFunction(() => Reflect.get(window, "__openAgentRecoveryMidBatch") === true);
  await expect.poll(() => threadEvents(page).some((event) => isEventType(event, "turn.cancelled"))).toBeTruthy();
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Continue after the boundary");
  await composer.press("Enter");
  await expect(page.getByText("Continue after the boundary", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const release = Reflect.get(window, "__openAgentReleaseRecoveryBoundary");
    if (typeof release === "function") release();
  });

  await expect.poll(() => followUpBody).toMatchObject({ message: "Continue after the boundary" });
  await expect(page.getByText("Boundary continuation completed.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
});

test("a follow-up after cancellation receives the interrupted task and completed tool context", async ({ page }) => {
  const sessionId = "mock-cancel-context-session";
  const at = new Date().toISOString();
  const turnId = "turn_0";
  const initialEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Build a clothing brand website", parts: [{ text: "Build a clothing brand website", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: "I will inspect the workspace first.", sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "message.completed" },
    { data: { actions: [{ callId: "call-todo", input: { todos: [{ content: "Inspect workspace", status: "in_progress" }] }, kind: "tool-call", toolName: "todo" }], sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "actions.requested" },
    { data: { result: { callId: "call-todo", kind: "tool-result", output: { completed: true }, toolName: "todo" }, sequence: 0, status: "completed", stepIndex: 0, turnId }, meta: { at }, type: "action.result" },
    { data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 100, outputTokens: 20 } }, meta: { at }, type: "step.completed" },
  ];
  const cancelledEvents = [
    ...initialEvents,
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.cancelled" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  const completedEvents = [
    ...cancelledEvents,
    { data: { sequence: 1, turnId: "turn_1" }, meta: { at }, type: "turn.started" },
    { data: { message: "Continue", parts: [{ text: "Continue", type: "text" }], sequence: 1, turnId: "turn_1" }, meta: { at }, type: "message.received" },
    { data: { sequence: 1, stepIndex: 0, turnId: "turn_1" }, meta: { at }, type: "step.started" },
    { data: { finishReason: "stop", message: "Resuming the clothing website.", sequence: 1, stepIndex: 0, turnId: "turn_1" }, meta: { at }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 1, stepIndex: 0, turnId: "turn_1", usage: { inputTokens: 120, outputTokens: 12 } }, meta: { at }, type: "step.completed" },
    { data: { sequence: 1, turnId: "turn_1" }, meta: { at }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  let cancelRequested = false;
  let followUpBody: Record<string, unknown> | undefined;

  await page.route("**/eve/v1/session", (route) => route.fulfill({
    body: JSON.stringify({ sessionId }),
    contentType: "application/json",
    headers: { "x-eve-session-id": sessionId },
    status: 200,
  }));
  await page.route(`**/eve/v1/session/${sessionId}/cancel`, async (route) => {
    cancelRequested = true;
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    followUpBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const startIndex = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? "0");
    const events = startIndex === 0
      ? initialEvents
      : followUpBody
        ? completedEvents.slice(startIndex)
        : cancelledEvents.slice(startIndex);
    await route.fulfill({
      body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Build a clothing brand website");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => cancelRequested).toBeTruthy();
  await expect.poll(() => {
    const context = firstStoredThread(page)?.retainedContext;
    return Array.isArray(context) ? context.join("\n") : "";
  }).toContain("Original user request: Build a clothing brand website");
  await expect.poll(() => threadEvents(page).some((event) => isEventType(event, "session.waiting"))).toBeTruthy();

  await composer.fill("Continue");
  await composer.press("Enter");
  await expect.poll(() => followUpBody).toBeDefined();
  expect(followUpBody).toMatchObject({ message: "Continue" });
  expect(JSON.stringify(followUpBody?.clientContext)).toContain("Original user request: Build a clothing brand website");
  expect(JSON.stringify(followUpBody?.clientContext)).toContain("Completed tool todo");
});

test("a historical cancelled thread backfills recovery context before its next follow-up", async ({ page }) => {
  const threadId = "historical-cancelled-thread";
  const sessionId = "historical-cancelled-session";
  const turnId = "turn_0";
  const at = new Date().toISOString();
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message: "Build a durable company website", parts: [{ text: "Build a durable company website", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: "I started inspecting the workspace.", sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "message.completed" },
    { data: { actions: [{ callId: "call-glob", input: { pattern: "**/*" }, kind: "tool-call", toolName: "glob" }], sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "actions.requested" },
    { data: { result: { callId: "call-glob", kind: "tool-result", output: { files: ["package.json"] }, toolName: "glob" }, sequence: 0, status: "completed", stepIndex: 0, turnId }, meta: { at }, type: "action.result" },
    { data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 100, outputTokens: 20 } }, meta: { at }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.cancelled" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  let followUpBody: Record<string, unknown> | undefined;
  setFakeThreadCollection(page, {
    activeThreadId: threadId,
    threads: [{
      closedInputRequestIds: [],
      createdAt: Date.now(),
      events,
      id: threadId,
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: events.length },
      status: "ready",
      title: "Company website",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    followUpBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, (route) => route.fulfill({
    body: mockContinuationTurn("Continue", "The website work is continuing.", 1),
    contentType: "application/x-ndjson",
    status: 200,
  }));

  await page.goto(`/threads/${threadId}`);
  await expect.poll(() => {
    const context = firstStoredThread(page)?.retainedContext;
    return Array.isArray(context) ? context.join("\n") : "";
  }).toContain("Original user request: Build a durable company website");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Continue");
  await composer.press("Enter");
  await expect.poll(() => followUpBody).toBeDefined();
  expect(JSON.stringify(followUpBody?.clientContext)).toContain("Original user request: Build a durable company website");
  expect(JSON.stringify(followUpBody?.clientContext)).toContain("Completed tool glob");
});

test("stop before turn admission stays immediate and retries against the authoritative turn id", async ({ page }) => {
  const sessionId = "mock-cancel-race-session";
  const turnId = "turn-race";
  const cancellations: Array<{ turnId?: string }> = [];
  let releaseStreams: (() => void) | undefined;
  const streamsMayFinish = new Promise<void>((resolve) => {
    releaseStreams = resolve;
  });
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/cancel`, async (route) => {
    cancellations.push((route.request().postDataJSON() ?? {}) as { turnId?: string });
    if (cancellations.length === 1) releaseStreams?.();
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await streamsMayFinish;
    const at = new Date().toISOString();
    await route.fulfill({
      body: `${[
        { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
        { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
        { data: { message: "Stop before admission", parts: [{ text: "Stop before admission", type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
        { data: { finishReason: "stop", message: "LATE RESPONSE", sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "message.completed" },
        { data: { sequence: 0, turnId }, meta: { at }, type: "turn.cancelled" },
        { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
      ].map((event) => JSON.stringify(event)).join("\n")}\n`,
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Stop before admission");
  await composer.press("Enter");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 100 });
  await expect.poll(() => cancellations.some((entry) => entry.turnId === turnId)).toBeTruthy();
  expect(cancellations[0]?.turnId).toBeUndefined();
  await expect(page.getByText("LATE RESPONSE", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("log").getByText("Stop before admission", { exact: true })).toBeVisible();
});

test("stop before session admission preserves the optimistic user message", async ({ page }) => {
  await page.route("**/eve/v1/session", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      body: JSON.stringify({ sessionId: "late-session-admission" }),
      contentType: "application/json",
      headers: { "x-eve-session-id": "late-session-admission" },
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Keep this message after stopping");
  await composer.press("Enter");
  await page.getByRole("button", { name: "Stop", exact: true }).click();

  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 200 });
  await expect(page.getByRole("log").getByText("Keep this message after stopping", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const pending = firstStoredThread(page)?.pendingTurn;
    if (typeof pending !== "object" || pending === null) return "";
    const record = pending as Record<string, unknown>;
    return `${String(record.state)}:${String(record.text)}`;
  }).toBe("interrupted:Keep this message after stopping");
});

test("stop cancels a recovered long-running turn after one bounded catch-up", async ({ page }) => {
  const sessionId = "mock-recovery-cancel-session";
  const turnId = "turn-recovery-cancel";
  const at = new Date().toISOString();
  const runningEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at, id: "evt-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-turn" }, type: "turn.started" },
    { data: { message: "Stop recovered work", parts: [{ text: "Stop recovered work", type: "text" }], sequence: 0, turnId }, meta: { at, id: "evt-message" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-step" }, type: "step.started" },
  ];
  const cancelledEvents = [
    ...runningEvents,
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-cancelled" }, type: "turn.cancelled" },
    { data: { wait: "next-user-message" }, meta: { at, id: "evt-waiting" }, type: "session.waiting" },
  ];
  let cancelRequested = false;
  let boundedTailRequests = 0;
  let releaseStreams: (() => void) | undefined;
  const streamsMayFinish = new Promise<void>((resolve) => {
    releaseStreams = resolve;
  });

  setFakeThreadCollection(page, {
    activeThreadId: "recovery-cancel-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: Date.now(),
      events: runningEvents,
      id: "recovery-cancel-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: runningEvents.length },
      status: "streaming",
      title: "Recovered work",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/eve/v1/session/${sessionId}/cancel`, async (route) => {
    cancelRequested = true;
    releaseStreams?.();
    expect((route.request().postDataJSON() as { turnId?: string }).turnId).toBe(turnId);
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("includeTailIndex")) boundedTailRequests += 1;
    await streamsMayFinish;
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    await route.fulfill({
      body: `${cancelledEvents.slice(startIndex).map((event) => JSON.stringify(event)).join("\n")}\n`,
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/threads/recovery-cancel-thread");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 300 });
  await expect.poll(() => cancelRequested).toBeTruthy();
  await expect.poll(() => firstStoredThread(page)?.status).toBe("ready");
  expect(boundedTailRequests).toBe(1);
});

function mockSuccessfulTurn(message: string, reply: string, sequence = 0): string {
  const at = new Date().toISOString();
  const turnId = `turn_${sequence}`;
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence, turnId }, meta: { at }, type: "turn.started" },
    { data: { message, parts: [{ text: message, type: "text" }], sequence, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
    { data: { finishReason: "stop", message: reply, sequence, stepIndex: 0, turnId }, meta: { at }, type: "message.completed" },
    { data: { finishReason: "stop", sequence, stepIndex: 0, turnId, usage: { inputTokens: 1, outputTokens: 1 } }, meta: { at }, type: "step.completed" },
    { data: { sequence, turnId }, meta: { at }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function mockCompletedChildTurn(message: string, reply: string): string {
  const events = eventsFromNdjson(mockSuccessfulTurn(message, reply));
  const at = new Date().toISOString();
  return `${[
    ...events.slice(0, -1),
    { data: { result: reply }, meta: { at }, type: "session.completed" },
  ].map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function mockToolTurn(
  message: string,
  reply: string,
  tool: { readonly input: unknown; readonly output: unknown; readonly toolName: string } = {
    input: { command: "find . -maxdepth 2 -type f" },
    output: { exitCode: 0, stderr: "", stdout: "./index.html", truncated: false },
    toolName: "bash",
  },
): string {
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const turnId = "turn_tool";
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at: at(0) }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at: at(100) }, type: "turn.started" },
    { data: { message, parts: [{ text: message, type: "text" }], sequence: 0, turnId }, meta: { at: at(200) }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at: at(300) }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: "Inspecting the workspace.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(500) }, type: "message.completed" },
    { data: { actions: [{ callId: "call-1", input: tool.input, kind: "tool-call", toolName: tool.toolName }], sequence: 0, stepIndex: 0, turnId }, meta: { at: at(600) }, type: "actions.requested" },
    { data: { result: { callId: "call-1", kind: "tool-result", output: tool.output, toolName: tool.toolName }, sequence: 0, status: "completed", stepIndex: 0, turnId }, meta: { at: at(1_200) }, type: "action.result" },
    { data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 10_000, outputTokens: 300 } }, meta: { at: at(1_300) }, type: "step.completed" },
    { data: { sequence: 0, stepIndex: 1, turnId }, meta: { at: at(1_400) }, type: "step.started" },
    { data: { finishReason: "stop", message: reply, sequence: 0, stepIndex: 1, turnId }, meta: { at: at(2_000) }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId, usage: { inputTokens: 10_600, outputTokens: 200 } }, meta: { at: at(2_100) }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at: at(2_200) }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at: at(2_300) }, type: "session.waiting" },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function mockReasoningMarkdownTurn(): string {
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const turnId = "turn_rich";
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at: at(0) }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at: at(100) }, type: "turn.started" },
    { data: { message: "Explain the result", parts: [{ text: "Explain the result", type: "text" }], sequence: 0, turnId }, meta: { at: at(200) }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at: at(300) }, type: "step.started" },
    { data: { reasoningDelta: "Check", reasoningSoFar: "Check the result.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(400) }, type: "reasoning.appended" },
    { data: { reasoning: "Check the result.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(1_700) }, type: "reasoning.completed" },
    { data: { finishReason: "stop", message: "## Result\n\n- Markdown is active.\n- Code blocks are styled.\n\n```ts\nconst ready = true;\n```", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(1_800) }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 128, outputTokens: 64 } }, meta: { at: at(1_900) }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at: at(2_000) }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at: at(2_100) }, type: "session.waiting" },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function mockQuestionTurn(): string {
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const turnId = "turn_question";
  const request = {
    action: {
      callId: "call-question",
      input: {
        allowFreeform: true,
        options: [
          { description: "留白充足，突出品牌内容", id: "minimal", label: "极简现代" },
          { description: "使用鲜明色彩和强烈层次", id: "bold", label: "大胆活力" },
          { description: "使用克制色彩和精致字体，适合高端品牌的长标题描述", id: "editorial", label: "编辑设计" },
        ],
        prompt: "你更喜欢哪种视觉方向？",
      },
      kind: "tool-call",
      toolName: "ask_question",
    },
    allowFreeform: true,
    display: "select",
    kind: "question",
    options: [
      { description: "留白充足，突出品牌内容", id: "minimal", label: "极简现代" },
      { description: "使用鲜明色彩和强烈层次", id: "bold", label: "大胆活力" },
      { description: "使用克制色彩和精致字体，适合高端品牌的长标题描述", id: "editorial", label: "编辑设计" },
    ],
    prompt: "你更喜欢哪种视觉方向？",
    requestId: "call-question",
  };
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at: at(0) }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at: at(100) }, type: "turn.started" },
    { data: { message: "帮我确定网站的视觉方向", parts: [{ text: "帮我确定网站的视觉方向", type: "text" }], sequence: 0, turnId }, meta: { at: at(200) }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at: at(300) }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId }, meta: { at: at(400) }, type: "message.completed" },
    { data: { actions: [request.action], sequence: 0, stepIndex: 0, turnId }, meta: { at: at(500) }, type: "actions.requested" },
    { data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 120, outputTokens: 24 } }, meta: { at: at(600) }, type: "step.completed" },
    { data: { requests: [request], sequence: 0, stepIndex: 0, turnId }, meta: { at: at(700) }, type: "input.requested" },
    { data: { sequence: 0, turnId }, meta: { at: at(800) }, type: "turn.completed" },
    { data: { wait: "input" }, meta: { at: at(900) }, type: "session.waiting" },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function mockContinuationTurn(message: string, reply: string, sequence = 1): string {
  const at = new Date().toISOString();
  const turnId = `turn_${sequence}`;
  const events = [
    { data: { sequence, turnId }, meta: { at }, type: "turn.started" },
    { data: { message, parts: [{ text: message, type: "text" }], sequence, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
    { data: { finishReason: "stop", message: reply, sequence, stepIndex: 0, turnId }, meta: { at }, type: "message.completed" },
    { data: { finishReason: "stop", sequence, stepIndex: 0, turnId, usage: { inputTokens: 2, outputTokens: 2 } }, meta: { at }, type: "step.completed" },
    { data: { sequence, turnId }, meta: { at }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function eventsFromNdjson(payload: string): readonly unknown[] {
  return payload
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function ndjson(events: readonly unknown[]): string {
  return events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withClientMessageId(
  events: readonly unknown[],
  clientMessageId: string,
): readonly unknown[] {
  return events.map((event) => {
    if (!isRecord(event) || event.type !== "message.received" || !isRecord(event.data)) return event;
    return { ...event, data: { ...event.data, clientMessageId } };
  });
}

function mockSteeredTurnRemainder(
  turnId: string,
  clientMessageId: unknown,
  message: string,
  reply: string,
): readonly unknown[] {
  const at = new Date().toISOString();
  const durableClientMessageId = typeof clientMessageId === "string" && clientMessageId
    ? clientMessageId
    : "missing-client-message-id";
  return [
    {
      data: {
        clientMessageId: durableClientMessageId,
        message,
        parts: [{ text: message, type: "text" }],
        sequence: 0,
        turnId,
      },
      meta: { at },
      type: "message.received",
    },
    { data: { sequence: 0, stepIndex: 1, turnId }, meta: { at }, type: "step.started" },
    {
      data: { finishReason: "stop", message: reply, sequence: 0, stepIndex: 1, turnId },
      meta: { at },
      type: "message.completed",
    },
    {
      data: {
        finishReason: "stop",
        sequence: 0,
        stepIndex: 1,
        turnId,
        usage: { inputTokens: 2, outputTokens: 2 },
      },
      meta: { at },
      type: "step.completed",
    },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at }, type: "session.waiting" },
  ];
}

function mockChildApprovalEvents(): readonly unknown[] {
  const base = Date.now() - 5_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  return [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at: at(0) }, type: "session.started" },
    { data: { sequence: 0, turnId: "turn-parent" }, meta: { at: at(100) }, type: "turn.started" },
    { data: { message: "Build an enterprise website", parts: [{ text: "Build an enterprise website", type: "text" }], sequence: 0, turnId: "turn-parent" }, meta: { at: at(200) }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId: "turn-parent" }, meta: { at: at(300) }, type: "step.started" },
    {
      data: {
        actions: [{
          callId: "call-agent-css",
          description: "Delegate stylesheet implementation",
          input: { message: "Build and validate the stylesheet" },
          kind: "subagent-call",
          name: "agent",
          nodeId: "agent-css",
          subagentName: "agent",
        }],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-parent",
      },
      meta: { at: at(400) },
      type: "actions.requested",
    },
    { data: { callId: "call-agent-css", childSessionId: "child-css", name: "agent", sequence: 0, sessionId: "mock-child-approval-session", toolName: "agent", turnId: "turn-parent", workflowId: "workflow-child-css" }, meta: { at: at(500) }, type: "subagent.called" },
    {
      data: {
        requests: [{
          action: { callId: "call-child-bash", input: { command: "npm test && rm -f /tmp/css-classes" }, kind: "tool-call", toolName: "bash" },
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "deny", label: "Deny", style: "danger" },
          ],
          prompt: "Allow the delegated task to validate and clean temporary files?",
          requestId: "request-child-bash",
        }],
        sequence: 0,
        stepIndex: 1,
        turnId: "turn-child",
      },
      meta: { at: at(700) },
      type: "input.requested",
    },
    { data: { sequence: 0, turnId: "turn-parent" }, meta: { at: at(800) }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at: at(900) }, type: "session.waiting" },
  ];
}

function mockChildApprovalResumeEvents(): string {
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const events = [
    { data: { sequence: 1, turnId: "turn-resumed" }, meta: { at: at(0) }, type: "turn.started" },
    { data: { callId: "call-agent-css", output: "Stylesheet complete", subagentName: "agent" }, meta: { at: at(100) }, type: "subagent.completed" },
    { data: { result: { callId: "call-agent-css", kind: "subagent-result", output: "Stylesheet complete", subagentName: "agent" }, sequence: 1, status: "completed", stepIndex: 0, turnId: "turn-resumed" }, meta: { at: at(200) }, type: "action.result" },
    { data: { sequence: 1, stepIndex: 0, turnId: "turn-resumed" }, meta: { at: at(300) }, type: "step.started" },
    { data: { finishReason: "stop", message: "The delegated task resumed and completed.", sequence: 1, stepIndex: 0, turnId: "turn-resumed" }, meta: { at: at(400) }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 1, stepIndex: 0, turnId: "turn-resumed", usage: { inputTokens: 20, outputTokens: 8 } }, meta: { at: at(500) }, type: "step.completed" },
    { data: { sequence: 1, turnId: "turn-resumed" }, meta: { at: at(600) }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at: at(700) }, type: "session.waiting" },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

type FakeStoredThread = {
  readonly events?: readonly unknown[];
  readonly id: string;
  readonly session?: {
    readonly sessionId?: string;
    readonly streamIndex?: number;
  };
  readonly [key: string]: unknown;
};

type FakeThreadCollection = {
  readonly activeThreadId?: string;
  readonly threads: readonly FakeStoredThread[];
  readonly version: number;
};

type FakeThreadStore = {
  collection: FakeThreadCollection;
  conflictsRemaining?: number;
  revision: number;
};

function setFakeThreadCollection(page: Page, collection: FakeThreadCollection): void {
  const store = threadStores.get(page);
  if (!store) throw new Error("The fake Agent thread store was not installed.");
  store.collection = collection;
  store.revision += 1;
}

function firstStoredThread(page: Page): FakeStoredThread | undefined {
  return threadStores.get(page)?.collection.threads[0];
}

function threadEvents(page: Page): readonly unknown[] {
  return firstStoredThread(page)?.events ?? [];
}

function isEventType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}
