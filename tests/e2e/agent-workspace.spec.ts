import { expect, test, type Page } from "@playwright/test";
import type { MessageStreamEvent } from "eve/client";
import { compactThreadEvents } from "@oworker/open-agent-ui/agent-workspace";
const threadStores = new WeakMap<Page, FakeThreadStore>();

test.beforeEach(async ({ page }, testInfo) => {
  // The live provider test must exercise the real standalone auth and
  // PostgreSQL-backed thread storage. The in-memory route below intentionally
  // omits Set-Cookie, which would make Eve's browser request look unauthenticated
  // even though the production route correctly issues open_agent_anonymous.
  if (process.env.RUN_AGENT_LIVE_E2E === "1" && testInfo.title.includes("real conversation survives refresh")) {
    return;
  }
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
          eventWindow: {
            endIndex: (store.collection.threads.find((thread) => thread.id === requestedThreadId)?.events ?? []).length,
            hasMoreBefore: false,
            startIndex: 0,
            total: (store.collection.threads.find((thread) => thread.id === requestedThreadId)?.events ?? []).length,
          },
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
        eventAppends?: readonly {
          readonly events: readonly MessageStreamEvent[];
          readonly replaceFrom?: number;
          readonly threadId: string;
        }[];
        upsertThreads?: FakeThreadCollection["threads"];
      };
      if (route.request().method() === "PATCH") {
        const deleted = new Set(body.deletedThreadIds ?? []);
        const replacements = new Map((body.upsertThreads ?? []).map((thread) => [thread.id, thread]));
        const appends = new Map((body.eventAppends ?? []).map((entry) => [entry.threadId, entry]));
        const retained = store.collection.threads
          .filter((thread) => !deleted.has(thread.id))
          .map((thread) => {
            const replacement = replacements.get(thread.id);
            const next = replacement?.hydration === "summary"
              ? { ...thread, ...replacement, events: thread.events, hydration: undefined }
              : replacement ?? thread;
            const appended = appends.get(thread.id);
            return appended && appended.events.length > 0
              ? {
                  ...next,
                  events: compactThreadEvents([
                    ...(next.events ?? []).slice(0, Math.min(appended.replaceFrom ?? next.events?.length ?? 0, next.events?.length ?? 0)) as readonly MessageStreamEvent[],
                    ...appended.events,
                  ]),
                }
              : next;
          });
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
  // The E2E harness replaces thread storage with an in-memory store, so the
  // production PostgreSQL ownership probe is unavailable here. Keep the
  // runtime boundary authoritative in the same way as a live Eve session;
  // individual settled-session tests register a newer waiting response.
  await page.route(/\/api\/standalone\/sessions\/[^/]+$/, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ ok: true, state: "running" }),
      contentType: "application/json",
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

test("a settled session renders the next message before its delayed stream", async ({ page }) => {
  const sessionId = "settled-follow-up-session";
  const firstTurn = eventsFromNdjson(mockSuccessfulTurn(
    "First request",
    `First done. ${"A long settled response keeps enough transcript height to exercise the top anchor. ".repeat(24)}`,
  ));
  const secondTurn = eventsFromNdjson(mockContinuationTurn(
    "Second request",
    `Second done. ${"The completed response must keep the submitted turn anchored instead of jumping to the bottom. ".repeat(24)}`,
  ));
  let streamRequests = 0;

  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamRequests += 1;
    if (streamRequests === 1) {
      await route.fulfill({
        body: ndjson(firstTurn),
        contentType: "application/x-ndjson",
        status: 200,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({
      body: ndjson(secondTurn),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("First request");
  await composer.press("Enter");
  await expect(page.getByText(/First done\./)).toBeVisible({ timeout: 5_000 });

  await composer.fill("Second request");
  await composer.press("Enter");
  await expect(page.getByRole("log").getByText("Second request", { exact: true })).toBeVisible({ timeout: 300 });
  await expect(page.getByRole("status").filter({ hasText: "Thinking" })).toBeVisible({ timeout: 300 });
  await expect(page.locator("[data-agent-steer-queue]")).toHaveCount(0);
  await expect(page.getByText(/Second done\./)).toBeVisible({ timeout: 5_000 });
});

test("a repeated prompt stays visible before its new stream is acknowledged", async ({ page }) => {
  const sessionId = "repeated-prompt-session";
  let streamRequests = 0;
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamRequests += 1;
    if (streamRequests === 1) {
      await route.fulfill({
        body: mockSuccessfulTurn("Repeat this request", "First response."),
        contentType: "application/x-ndjson",
        status: 200,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({
      body: mockContinuationTurn("Repeat this request", "Second response.", 1),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Repeat this request");
  await composer.press("Enter");
  await expect(page.getByText("First response.", { exact: true })).toBeVisible({ timeout: 5_000 });
  await composer.fill("Repeat this request");
  await composer.press("Enter");
  await expect(page.getByRole("log").getByText("Repeat this request", { exact: true })).toHaveCount(2, { timeout: 300 });
  await expect(page.getByRole("status").filter({ hasText: "Thinking" })).toBeVisible({ timeout: 300 });
  await expect(page.getByText("Second response.", { exact: true })).toBeVisible({ timeout: 5_000 });
});

test("transient session admission errors retry with a stable bounded counter", async ({ page }) => {
  let attempts = 0;
  await page.route("**/eve/v1/session", async (route) => {
    attempts += 1;
    if (attempts === 1 || attempts === 2) {
      await route.fulfill({
        body: JSON.stringify({ code: attempts === 1 ? "provider_unavailable" : "gateway_busy", error: "The model Provider is temporarily unavailable." }),
        contentType: "application/json",
        status: attempts === 1 ? 503 : 502,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ sessionId: "retry-session" }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/eve/v1/session/retry-session/stream**", async (route) => {
    await route.fulfill({
      body: mockSuccessfulTurn("Retry this request", "Recovered after retry."),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Retry this request");
  await composer.press("Enter");
  await expect(composer).toHaveText("", { timeout: 300 });
  await expect(page.getByText("Retrying request (1/3)", { exact: true })).toBeVisible({ timeout: 3_000 });
  await expect(page.locator('[data-agent-retry]').first()).toHaveAttribute("data-state", "closed");
  await expect(page.getByText("Recovered after retry.", { exact: true })).toBeVisible({ timeout: 8_000 });
  expect(attempts).toBe(3);
});

test("a permanent Provider 404 is terminal and never enters a retry loop", async ({ page }) => {
  const sessionId = "terminal-provider-404-session";
  let streamRequests = 0;
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamRequests += 1;
    await route.fulfill({
      body: JSON.stringify({
        code: "MODEL_CALL_FAILED",
        error: "The model Provider request failed (HTTP 404).",
      }),
      contentType: "application/json",
      status: 404,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Use the unavailable model");
  await composer.press("Enter");
  await expect(page.getByText("Model request failed", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(/Retrying request|Retry failed/)).toHaveCount(0);
  await expect(page.locator('[data-agent-failure-alert]')).toBeVisible();
  await expect(page.locator('[data-slot="collapsible"].group\\/execution')).toHaveCount(0);
  await expect(page.getByRole("log").getByText("Use the unavailable model", { exact: true })).toHaveCount(1);
  await page.waitForTimeout(1_500);
  expect(streamRequests).toBe(1);
});

test("a terminal Provider turn failure uses the retry presentation at its Agent message", async ({ page }) => {
  const sessionId = "provider-failure-session";
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    await route.fulfill({
      body: mockProviderFailureTurn("Build the enterprise website"),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Build the enterprise website");
  await composer.press("Enter");
  await expect(page.getByText(/Retry failed/)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("log").getByText("Build the enterprise website", { exact: true })).toHaveCount(1);
  await expect(page.getByText("This turn failed", { exact: true })).toHaveCount(0);
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
    if (request.method() === "GET" && url.pathname.includes("/thread-collections/") && url.searchParams.get("threadId")) {
      transcriptRequests.push(url.search);
    }
  });
  await page.goto("/");
  await expect(page.getByText("Stored response", { exact: true })).toHaveCount(0);
  await page.locator("aside").getByRole("button", { name: /Stored history/ }).click();
  await expect(page.getByText("Stored response", { exact: true })).toBeVisible();
  expect(transcriptRequests.filter((search) => !search.includes("view=index"))).toHaveLength(1);
});

test("a settled transcript with stale coverage is not replayed from Eve", async ({ page }) => {
  test.skip(!process.env.AGENT_DATABASE_URL, "Requires the server-backed thread storage boundary.");
  const now = Date.now();
  const events = mockSuccessfulTurn("Stored request", "Stored response")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  setFakeThreadCollection(page, {
    activeThreadId: "stale-coverage-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: now,
      events,
      id: "stale-coverage-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId: "stale-coverage-session", streamIndex: events.length + 10 },
      status: "ready",
      title: "Settled history",
      transcriptCoverage: { complete: true, endIndex: 4, startIndex: 0, version: 1 },
      updatedAt: now,
    }],
    version: 2,
  });
  let repairRequests = 0;
  let runtimeInspectionRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/thread-collections/") && request.url().includes("/repair")) {
      repairRequests += 1;
    }
    if (request.method() === "GET" && request.url().includes("/api/standalone/sessions/stale-coverage-session")) {
      runtimeInspectionRequests += 1;
    }
  });
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: /Settled history/ }).click();
  await expect(page.getByText("Stored response", { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  expect(repairRequests).toBe(0);
  expect(runtimeInspectionRequests).toBe(0);
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
  await expect(page.getByRole("button", { name: /Terminal command/u })).toBeVisible();
  await page.getByRole("button", { name: /Terminal command/u }).click();
  await expect(page.getByText(/exitCode/u)).toHaveCount(0);
  await expect(page.locator('[data-slot="tool-group-root"][data-variant="ghost"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="tool-fallback-root"]')).toBeVisible();
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
  const execution = page.getByRole("button", { name: /Worked for/u }).first();
  if (await execution.getAttribute("aria-expanded") !== "true") await execution.click();
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
  await expect(page.getByRole("button", { name: "Reasoning complete 1s", exact: true })).toBeVisible();
  await expect(page.getByText("Reasoning", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);

  const userMessage = page.getByRole("log").getByText("Explain the result", { exact: true });
  await userMessage.hover();
  await expect(page.getByRole("button", { name: "Edit message" })).toBeVisible();

  const assistantRoot = page.locator('[data-message-id]').filter({ hasText: "Result" }).last();
  await assistantRoot.hover();
  const assistantCopy = assistantRoot.getByRole("button", { name: "Copy response" });
  await expect(assistantCopy).toBeVisible();
  const rootBox = await assistantRoot.boundingBox();
  const copyBox = await assistantCopy.boundingBox();
  expect(copyBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThan((rootBox?.x ?? 0) + (rootBox?.width ?? 0) / 2);
});

test("investigation: sample assistant message transitions without visual remount", async ({ page }) => {
  const sessionId = "investigation-flash-session";
  const turnId = "turn_investigation_flash";
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at: at(0), id: "evt-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at: at(10), id: "evt-turn" }, type: "turn.started" },
    { data: { message: "Investigate flash", parts: [{ text: "Investigate flash", type: "text" }], sequence: 0, turnId }, meta: { at: at(20), id: "evt-user" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at: at(30), id: "evt-step" }, type: "step.started" },
    { data: { reasoningDelta: "Plan", reasoningSoFar: "Plan the transition", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(120), id: "evt-reasoning" }, type: "reasoning.appended" },
    { data: { reasoning: "Plan the transition", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(260), id: "evt-reasoning-complete" }, type: "reasoning.completed" },
    { data: { finishReason: "tool-calls", message: "Inspecting the workspace.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(300), id: "evt-message-before-tool" }, type: "message.completed" },
    { data: { actions: [{ callId: "call-inspect", input: { command: "pwd" }, kind: "tool-call", toolName: "bash" }], sequence: 0, stepIndex: 0, turnId }, meta: { at: at(340), id: "evt-actions" }, type: "actions.requested" },
    { data: { result: { callId: "call-inspect", kind: "tool-result", output: "/workspace", toolName: "bash" }, sequence: 0, status: "completed", stepIndex: 0, turnId }, meta: { at: at(380), id: "evt-action-result" }, type: "action.result" },
    { data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 1, outputTokens: 1 } }, meta: { at: at(400), id: "evt-step-complete" }, type: "step.completed" },
    { data: { sequence: 0, stepIndex: 1, turnId }, meta: { at: at(420), id: "evt-step-1" }, type: "step.started" },
    { data: { finishReason: "stop", message: "Done", sequence: 0, stepIndex: 1, turnId }, meta: { at: at(460), id: "evt-final-message" }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId, usage: { inputTokens: 2, outputTokens: 2 } }, meta: { at: at(480), id: "evt-final-step-complete" }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at: at(500), id: "evt-turn-complete" }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at: at(520), id: "evt-waiting" }, type: "session.waiting" },
  ];
  await page.addInitScript(({ streamEvents, targetSessionId }) => {
    const nativeFetch = window.fetch.bind(window);
    const browser = window as typeof window & { __flashSamples?: Array<Record<string, unknown>>; __flashNodeId?: number };
    browser.__flashSamples = [];
    browser.__flashNodeId = 0;
    window.fetch = async (input, init) => {
      const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url, window.location.href);
      if (requestUrl.pathname !== `/eve/v1/session/${targetSessionId}/stream`) return await nativeFetch(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      let index = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException("Aborted", "AbortError"));
            return;
          }
          const event = streamEvents[index++];
          if (!event) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
          await new Promise((resolve) => setTimeout(resolve, event.type === "reasoning.appended" ? 180 : 45));
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
    };
    const sample = () => {
      const log = document.querySelector('[role="log"]');
      const articles = log ? [...log.querySelectorAll("article")] : [];
      const articleRecords = articles.map((article) => ({
        messageId: article.parentElement?.parentElement?.getAttribute("data-message-id") ?? "",
        role: article.className.includes("items-end") ? "user" : "assistant",
      }));
      const messageRoots = log ? [...log.querySelectorAll("[data-message-id]")].map((root) => ({
        id: root.getAttribute("data-message-id") ?? "",
        top: root.getAttribute("data-aui-top-anchor-target") !== null,
        user: root.getAttribute("data-aui-top-anchor-user") !== null,
      })) : [];
      const assistant = articles.find((article) => !article.querySelector('[data-slot="message-content"]')) ?? articles.at(-1);
      if (assistant && !(assistant as HTMLElement).dataset.flashNodeId) {
        browser.__flashNodeId = (browser.__flashNodeId ?? 0) + 1;
        (assistant as HTMLElement).dataset.flashNodeId = String(browser.__flashNodeId);
      }
      const roots = assistant ? [...assistant.querySelectorAll('[data-slot="reasoning-root"]')] : [];
      for (const root of roots) {
        if (!(root as HTMLElement).dataset.flashReasoningId) {
          browser.__flashNodeId = (browser.__flashNodeId ?? 0) + 1;
          (root as HTMLElement).dataset.flashReasoningId = String(browser.__flashNodeId);
        }
      }
      browser.__flashSamples?.push({
        assistantCount: articles.length,
        articleRecords,
        messageRoots,
        assistantAttributes: assistant ? Object.fromEntries([...assistant.attributes].map((attribute) => [attribute.name, attribute.value])) : {},
        assistantHtml: assistant?.innerHTML.slice(0, 1000) ?? "",
        assistantId: assistant ? (assistant as HTMLElement).dataset.testid ?? "" : "",
        assistantNodeId: assistant ? (assistant as HTMLElement).dataset.flashNodeId ?? "" : "",
        assistantParentAttributes: assistant?.parentElement ? Object.fromEntries([...assistant.parentElement.attributes].map((attribute) => [attribute.name, attribute.value])) : {},
        assistantOuterAttributes: assistant?.parentElement?.parentElement ? Object.fromEntries([...assistant.parentElement.parentElement.attributes].map((attribute) => [attribute.name, attribute.value])) : {},
        assistantY: assistant?.getBoundingClientRect().y ?? null,
        assistantHeight: assistant?.getBoundingClientRect().height ?? null,
        reasoningCount: roots.length,
        reasoningNodeIds: roots.map((root) => (root as HTMLElement).dataset.flashReasoningId ?? ""),
        reasoningControls: roots.map((root) => root.querySelector("[data-slot=reasoning-trigger]")?.getAttribute("aria-controls") ?? ""),
        reasoningLabels: roots.map((root) => root.textContent ?? ""),
        scrollTop: log?.scrollTop ?? null,
        time: performance.now(),
      });
      if (performance.now() < 4000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { streamEvents: events, targetSessionId: sessionId });
  await page.route("**/eve/v1/session", async (route) => route.fulfill({ body: JSON.stringify({ sessionId }), contentType: "application/json", status: 200 }));
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Investigate flash");
  await composer.press("Enter");
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(250);
  const samples = await page.evaluate(() => (window as typeof window & { __flashSamples?: Array<Record<string, unknown>> }).__flashSamples ?? []);
  const visibleSamples = samples.filter((sample) => typeof sample.assistantNodeId === "string" && sample.assistantNodeId.length > 0);
  expect(visibleSamples.length).toBeGreaterThan(0);
  const assistantNodeIds = new Set(visibleSamples.map((sample) => sample.assistantNodeId));
  expect(assistantNodeIds.size).toBe(1);
  const reasoningNodeIds = new Set(
    visibleSamples.flatMap((sample) => {
      const ids = Array.isArray(sample.reasoningNodeIds) ? sample.reasoningNodeIds : [];
      const labels = Array.isArray(sample.reasoningLabels) ? sample.reasoningLabels : [];
      return ids.filter((_, index) => typeof labels[index] === "string" && labels[index] !== "Thinking");
    }),
  );
  expect(reasoningNodeIds.size).toBe(1);
  const placeholderSamples = visibleSamples.filter((sample) => {
    const labels = Array.isArray(sample.reasoningLabels) ? sample.reasoningLabels : [];
    return labels.length > 0 && labels.every((label) => label === "Thinking");
  });
  expect(placeholderSamples.every((sample) => sample.reasoningCount === 1)).toBe(true);
  for (const sample of visibleSamples) {
    const roots = Array.isArray(sample.messageRoots) ? sample.messageRoots as Array<{ id: string }> : [];
    const userIndex = roots.findIndex((root) => root.id.endsWith(":user"));
    const assistantIndex = roots.findIndex((root) => root.id.endsWith(":assistant"));
    if (userIndex >= 0 && assistantIndex >= 0) expect(userIndex).toBeLessThan(assistantIndex);
  }
});

test("a second turn keeps its thinking placeholder visible before the Provider responds", async ({ page }) => {
  const sessionId = "investigation-second-turn-session";
  const firstTurn = eventsFromNdjson(mockSuccessfulTurn("First turn", "First completed", 0));
  // A follow-up stream starts at the next turn; Eve does not replay the
  // session.started envelope when reusing the parked session.
  const secondTurn = eventsFromNdjson(mockContinuationTurn("Second turn", "Second completed", 1));
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
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    streamCalls += 1;
    if (streamCalls > 1) await new Promise((resolve) => setTimeout(resolve, 800));
    const events = streamCalls === 1 ? firstTurn : secondTurn;
    await route.fulfill({
      body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("First turn");
  await composer.press("Enter");
  await expect(page.getByText("First completed", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await page.waitForTimeout(250);
  await composer.fill("Second turn");
  await composer.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Thinking" })).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText("Second completed", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("log").getByText("Second turn", { exact: true })).toHaveCount(1);
});

test("provider failure feedback does not remount the active reasoning row", async ({ page }) => {
  const sessionId = "investigation-failure-flash-session";
  const turnId = "turn_investigation_failure_flash";
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at: at(0), id: "failure-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at: at(10), id: "failure-turn" }, type: "turn.started" },
    { data: { message: "Investigate failure", parts: [{ text: "Investigate failure", type: "text" }], sequence: 0, turnId }, meta: { at: at(20), id: "failure-user" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at: at(30), id: "failure-step" }, type: "step.started" },
    { data: { reasoningDelta: "Check", reasoningSoFar: "Check the workspace.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(120), id: "failure-reasoning" }, type: "reasoning.appended" },
    { data: { reasoning: "Check the workspace.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(260), id: "failure-reasoning-complete" }, type: "reasoning.completed" },
    { data: { finishReason: "tool-calls", message: "Inspecting the workspace.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(300), id: "failure-message" }, type: "message.completed" },
    { data: { actions: [{ callId: "call-failure", input: { command: "pwd" }, kind: "tool-call", toolName: "bash" }], sequence: 0, stepIndex: 0, turnId }, meta: { at: at(340), id: "failure-actions" }, type: "actions.requested" },
    { data: { code: "provider_stream_interrupted", message: "The model Provider stream ended before completion.", sequence: 0, stepIndex: 0, turnId }, meta: { at: at(420), id: "failure-step-failed" }, type: "step.failed" },
    { data: { code: "provider_stream_interrupted", message: "The model Provider stream ended before completion.", sequence: 0, turnId }, meta: { at: at(460), id: "failure-turn-failed" }, type: "turn.failed" },
    { data: { wait: "next-user-message" }, meta: { at: at(500), id: "failure-waiting" }, type: "session.waiting" },
  ];
  await page.addInitScript(({ streamEvents, targetSessionId }) => {
    const nativeFetch = window.fetch.bind(window);
    const browser = window as typeof window & { __failureSamples?: Array<Record<string, unknown>>; __failureNodeId?: number };
    browser.__failureSamples = [];
    browser.__failureNodeId = 0;
    window.fetch = async (input, init) => {
      const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url, window.location.href);
      if (requestUrl.pathname !== `/eve/v1/session/${targetSessionId}/stream`) return await nativeFetch(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      let index = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException("Aborted", "AbortError"));
            return;
          }
          const event = streamEvents[index++];
          if (!event) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
          await new Promise((resolve) => setTimeout(resolve, 45));
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
    };
    const sample = () => {
      const article = document.querySelector('[role="log"] article:not(:has([data-slot="message-content"]))') ?? document.querySelector('[role="log"] article');
      if (article) {
        const roots = [...article.querySelectorAll('[data-slot="reasoning-root"]')];
        for (const root of roots) {
          if (!(root as HTMLElement).dataset.failureFlashId) {
            browser.__failureNodeId = (browser.__failureNodeId ?? 0) + 1;
            (root as HTMLElement).dataset.failureFlashId = String(browser.__failureNodeId);
          }
        }
        browser.__failureSamples?.push({
          ids: roots.map((root) => (root as HTMLElement).dataset.failureFlashId ?? ""),
          labels: roots.map((root) => root.textContent ?? ""),
          time: performance.now(),
        });
      }
      if (performance.now() < 4000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { streamEvents: events, targetSessionId: sessionId });
  await page.route("**/eve/v1/session", async (route) => route.fulfill({ body: JSON.stringify({ sessionId }), contentType: "application/json", status: 200 }));
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Investigate failure");
  await composer.press("Enter");
  await expect(page.getByText("Retry failed", { exact: false })).toBeVisible({ timeout: 8_000 });
  const samples = await page.evaluate(() => (window as typeof window & { __failureSamples?: Array<Record<string, unknown>> }).__failureSamples ?? []);
  const ids = new Set(samples.flatMap((sample) => Array.isArray(sample.ids) ? sample.ids : []));
  expect(ids.size).toBe(1);
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

test("Codex apply_patch envelopes render with the assistant-ui diff viewer and live counts", async ({ page }) => {
  const sessionId = "mock-patch-viewer-session";
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "@@ -1 +1 @@",
    "-export const ready = false;",
    "+export const ready = true;",
    "*** End Patch",
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
        output: { changes: [{ addedLines: 1, deletedLines: 1, kind: "update", path: "/workspace/src/app.ts" }], filesChanged: 1, totalAddedLines: 1, totalDeletedLines: 1 },
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
  await page.getByRole("button", { name: /Edited src\/app\.ts \+1 -1/u }).click();

  const diffViewer = page.locator('[data-tool-view="diff"] [data-slot="diff-viewer"]');
  await expect(diffViewer).toBeVisible();
  await expect(diffViewer.locator('[data-slot="diff-viewer-stats"]')).toHaveText("+1-1");
  await expect(diffViewer).toContainText("export const ready = false;");
  await expect(diffViewer).toContainText("export const ready = true;");
});

test("view_image renders a native preview card without exposing base64 as text", async ({ page }) => {
  const sessionId = "mock-view-image-session";
  const assetId = "asset-view-image-preview";
  const dataBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(dataBase64, "base64").byteLength;
  await page.route(`**/api/assets/${assetId}`, async (route) => {
    await route.fulfill({
      body: Buffer.from(dataBase64, "base64"),
      contentType: "image/png",
      status: 200,
    });
  });
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
      body: mockToolTurn("Inspect the image", "The image is visible.", {
        input: { path: "/workspace/reference.png" },
        output: {
          assetId,
          assetRef: "workspace:/workspace/reference.png",
          bytes,
          dimensions: { height: 1, width: 1 },
          mediaType: "image/png",
          originalBytes: 2_048,
          path: "/workspace/reference.png",
          resized: true,
        },
        toolName: "view_image",
      }),
      contentType: "application/x-ndjson",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Inspect the image");
  await composer.press("Enter");
  await page.getByRole("button", { name: /Worked for/u }).click();
  await page.getByRole("button", { name: /Viewed image \/workspace\/reference\.png/u }).click();

  const view = page.locator('[data-tool-view="view-image"]');
  await expect(view).toBeVisible();
  await expect(view.locator('[data-slot="attachment"]')).toBeVisible();
  await expect(view).toContainText("/workspace/reference.png");
  await expect(view).toContainText("image/png");
  await expect(view).toContainText("1\u00d71");
  await expect(view).toContainText("resized from 2.0 KB");
  await expect(view.locator("img").first()).toHaveAttribute("src", `/api/assets/${assetId}`);
  await expect(page.locator('[data-tool-view="fallback"]')).toHaveCount(0);
  expect(await page.locator("body").evaluate((body, marker) => (body.textContent ?? "").includes(marker), dataBase64)).toBe(false);

  await view.getByRole("button", { name: "Preview /workspace/reference.png" }).click();
  await expect(page.getByRole("button", { name: "Close image preview" })).toBeVisible();
});

test("secondary view lists session assets and previews markdown, images, and downloads", async ({ page }) => {
  const sessionId = "asset-secondary-session";
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const events = eventsFromNdjson(mockSuccessfulTurn("Review the session assets", "Assets are ready."));
  setFakeThreadCollection(page, {
    activeThreadId: "asset-secondary-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: Date.now(),
      events,
      id: "asset-secondary-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: events.length },
      status: "ready",
      title: "Session assets",
      updatedAt: Date.now(),
      version: 2,
    }],
    version: 2,
  });

  await page.route(`**/api/assets?sessionId=${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        assets: [
          {
            assetId: "asset-hero-image",
            filename: "hero.png",
            mediaType: "image/png",
            sizeBytes: imageBytes.byteLength,
          },
          {
            assetId: "asset-readme",
            filename: "README.md",
            mediaType: "text/markdown",
            sizeBytes: 44,
          },
          {
            assetId: "asset-bundle",
            filename: "site.zip",
            mediaType: "application/zip",
            sizeBytes: 1_024,
          },
        ],
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route("**/api/assets/asset-hero-image", async (route) => {
    await route.fulfill({ body: imageBytes, contentType: "image/png", status: 200 });
  });
  await page.route("**/api/assets/asset-readme", async (route) => {
    await route.fulfill({
      body: "# Delivered site\n\nThe preview is ready.\n",
      contentType: "text/markdown; charset=utf-8",
      status: 200,
    });
  });
  await page.route("**/api/assets/asset-bundle", async (route) => {
    await route.fulfill({ body: Buffer.from("zip fixture"), contentType: "application/zip", status: 200 });
  });

  await page.goto("/threads/asset-secondary-thread");
  await expect(page.getByText("Assets are ready.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open side view", exact: true }).click();
  const secondary = page.locator("[data-agent-secondary-view]");
  await expect(secondary).toBeVisible();
  await secondary.getByRole("button", { name: /Session assets\s*3/u }).click();
  await expect(secondary.getByText("hero.png", { exact: true })).toBeVisible();
  await expect(secondary.getByText("README.md", { exact: true })).toBeVisible();
  await expect(secondary.getByText("site.zip", { exact: true })).toBeVisible();

  await secondary.getByRole("button", { name: "Preview hero.png", exact: true }).click();
  await expect(secondary.locator("h2")).toHaveText("hero.png");
  await expect(secondary.locator('img[alt="hero.png"]')).toBeVisible();
  await secondary.getByRole("button", { name: "Back to list", exact: true }).click();

  await secondary.getByRole("button", { name: "Open README.md", exact: true }).click();
  await expect(secondary.locator("h2")).toHaveText("README.md");
  await expect(secondary.locator(".aui-md")).toContainText("Delivered site");
  await expect(secondary.locator(".aui-md")).toContainText("The preview is ready.");
  await secondary.getByRole("button", { name: "Back to list", exact: true }).click();

  await secondary.getByRole("button", { name: "Open site.zip", exact: true }).click();
  await expect(secondary.locator("h2")).toHaveText("site.zip");
  const download = secondary.getByRole("link", { name: /下载文件|Download/u });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute("download", "site.zip");
});

test("published turn results open a durable multi-tab workbench with an isolated website preview", async ({ page }) => {
  const sessionId = "deliverable-workbench-session";
  const previewId = "prv_123e4567-e89b-12d3-a456-426614174000";
  const artifactId = "art_123e4567-e89b-12d3-a456-426614174000";
  const previewUrl = `/api/previews/${previewId}/index.html?token=signed-preview`;
  const artifactUrl = `/api/artifacts/${artifactId}?token=signed-artifact`;
  const createdAt = "2029-01-01T00:00:00.000Z";
  const expiresAt = "2030-01-01T00:00:00.000Z";
  const events = eventsFromNdjson(mockToolTurn("Publish the website", "The website is ready.", {
    input: { entrypoint: "index.html", root: "." },
    output: {
      bytes: 512,
      createdAt,
      entrypoint: "index.html",
      expiresAt,
      fileCount: 2,
      kind: "website-preview",
      previewId,
      url: previewUrl,
    },
    toolName: "publish_preview",
  }));
  setFakeThreadCollection(page, {
    activeThreadId: "deliverable-workbench-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: Date.now(),
      events,
      id: "deliverable-workbench-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: events.length },
      status: "ready",
      title: "Published website",
      updatedAt: Date.now(),
      version: 2,
    }],
    version: 2,
  });
  await page.route(`**/api/deliverables?sessionId=${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        deliverables: [
          { createdAt, expiresAt, fileCount: 2, id: previewId, kind: "website-preview", mediaType: "text/html", sizeBytes: 512, title: "index.html", url: previewUrl },
          { createdAt, expiresAt, id: artifactId, kind: "artifact", mediaType: "text/markdown", sizeBytes: 32, title: "result.md", url: artifactUrl },
        ],
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/api/assets?sessionId=${sessionId}`, async (route) => {
    await route.fulfill({ body: JSON.stringify({ assets: [], ok: true }), contentType: "application/json", status: 200 });
  });
  await page.route(`**/api/previews/${previewId}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill(pathname.endsWith("styles.css")
      ? { body: "h1 { color: rgb(12, 90, 180); }", contentType: "text/css", status: 200 }
      : { body: '<!doctype html><link rel="stylesheet" href="styles.css"><h1>Durable preview</h1>', contentType: "text/html", status: 200 });
  });
  await page.route(`**/api/artifacts/${artifactId}**`, async (route) => {
    await route.fulfill({ body: "# Published result\n\nReady for review.", contentType: "text/markdown", status: 200 });
  });

  await page.goto("/threads/deliverable-workbench-thread");
  const resultCard = page.locator('[data-turn-deliverables] [data-slot="artifact-card"]');
  await expect(resultCard).toBeVisible();
  await expect(resultCard).toContainText("index.html");
  await resultCard.click();

  const secondary = page.locator("[data-agent-secondary-view]");
  await expect(secondary).toBeVisible();
  await expect(secondary.locator("h2")).toHaveText("index.html");
  await expect(secondary.locator('[data-slot="web-preview"]')).toBeVisible();
  const previewFrame = secondary.frameLocator('iframe[title="index.html"]');
  await expect(previewFrame.getByRole("heading", { name: "Durable preview" })).toBeVisible();
  await expect(previewFrame.getByRole("heading", { name: "Durable preview" })).toHaveCSS("color", "rgb(12, 90, 180)");

  await secondary.getByRole("button", { name: "Back to list", exact: true }).click();
  await secondary.getByRole("button", { name: "Open result.md", exact: true }).click();
  await expect(secondary.locator("h2")).toHaveText("result.md");
  await expect(secondary.locator(".aui-md")).toContainText("Published result");
  await expect(secondary.getByRole("button", { name: "index.html", exact: true })).toBeVisible();
  await expect(secondary.getByRole("button", { name: "result.md", exact: true })).toBeVisible();
  await secondary.getByRole("button", { name: "index.html", exact: true }).click();
  await expect(secondary.locator('[data-slot="web-preview"]')).toBeVisible();
  await secondary.getByRole("button", { name: "Close result.md", exact: true }).click();
  await expect(secondary.getByRole("button", { name: "result.md", exact: true })).toHaveCount(0);
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
  const stylesheets = await previewPage.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => {
    const stylesheet = (link as HTMLLinkElement).sheet;
    return { loaded: Boolean(stylesheet), rules: stylesheet?.cssRules.length ?? 0 };
  }));
  expect(stylesheets.some(({ loaded, rules }) => loaded && rules > 0)).toBeTruthy();
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
  await expect(page.getByText("Retry failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("log").getByText(original, { exact: true })).toHaveCount(1);
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

test("a queued follow-up does not replace a healthy stream during prolonged Provider silence", async ({ page }) => {
  const sessionId = "mock-slow-provider-queued-follow-up-session";
  let liveStreamRequests = 0;
  let mailboxRequests = 0;
  let mailboxInspections = 0;

  await page.clock.install();
  await page.addInitScript((targetSessionId) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        window.location.href,
      );
      if (requestUrl.pathname !== `/eve/v1/session/${targetSessionId}/stream`) {
        return await nativeFetch(input, init);
      }
      if (requestUrl.searchParams.get("includeTailIndex") === "1") {
        return new Response("", {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-stream-tail-index": "-1",
          },
          status: 200,
        });
      }
      const counts = window as typeof window & { __openAgentLiveStreamRequests?: number };
      counts.__openAgentLiveStreamRequests = (counts.__openAgentLiveStreamRequests ?? 0) + 1;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = new ReadableStream({
        start(controller) {
          const at = new Date().toISOString();
          controller.enqueue(new TextEncoder().encode(`${[
            {
              data: {
                runtime: {
                  agentId: "open-agent",
                  agentName: "open-agent",
                  eveVersion: "test",
                  modelId: "mock/model",
                },
              },
              meta: { at, id: "evt-slow-session" },
              type: "session.started",
            },
            {
              data: { sequence: 0, turnId: "turn-slow-provider" },
              meta: { at, id: "evt-slow-turn" },
              type: "turn.started",
            },
          ].map((event) => JSON.stringify(event)).join("\n")}\n`));
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
        status: 200,
      });
    };
  }, sessionId);
  await page.route("**/eve/v1/session", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ sessionId }),
      contentType: "application/json",
      headers: { "x-eve-session-id": sessionId },
      status: 200,
    });
  });
  await page.route("**/api/standalone/mailbox", async (route) => {
    mailboxRequests += 1;
    const body = route.request().postDataJSON() as { clientMessageId: string };
    await route.fulfill({
      body: JSON.stringify({
        item: { clientMessageId: body.clientMessageId, itemId: "mail-slow-follow-up", status: "queued" },
        ok: true,
      }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route("**/api/standalone/mailbox/mail-slow-follow-up", async (route) => {
    mailboxInspections += 1;
    await route.fulfill({
      body: JSON.stringify({
        item: { clientMessageId: "pending-slow-follow-up", itemId: "mail-slow-follow-up", status: "queued" },
        ok: true,
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Run a Provider call that remains silent for over thirty seconds");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await composer.fill("Keep this follow-up queued without replacing the live stream");
  await composer.press("Enter");
  await expect(page.locator("[data-agent-steer-queue]")).toContainText(
    "Keep this follow-up queued without replacing the live stream",
  );

  await page.clock.runFor(36_000);
  liveStreamRequests = await page.evaluate(() =>
    (window as typeof window & { __openAgentLiveStreamRequests?: number }).__openAgentLiveStreamRequests ?? 0
  );
  expect(liveStreamRequests).toBe(1);
  expect(mailboxRequests).toBe(1);
  expect(mailboxInspections).toBeGreaterThan(0);
  await expect(page.getByRole("status").filter({ hasText: "Thinking" })).toBeVisible();
  await expect(page.locator("[data-agent-steer-queue]")).toBeVisible();
  await expect(page.getByText("Reconnecting to the active run...")).toHaveCount(0);
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
    expectedTurnId: "turn_tool",
    message: "Add the requested footer",
    operationKind: "steer",
    sessionId,
  });
  expect(mailboxBody?.operationId).toBe(mailboxBody?.clientMessageId);
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
  let runtimeWaiting = false;

  await page.route(`**/api/standalone/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        ok: true,
        state: runtimeWaiting ? "waiting" : "running",
        ...(runtimeWaiting
          ? { tailIndex: settledEvents.length + admittedEvents.length - 1 }
          : {}),
      }),
      contentType: "application/json",
      status: 200,
    });
  });

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
    runtimeWaiting = true;
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
  const approvalTakeover = page.locator("[data-agent-approval-takeover]");
  await expect(approvalTakeover).toBeVisible();
  await expect(approvalTakeover).toContainText("Approve tool call: Terminal command");
  await expect(page.getByRole("textbox", { name: "Do anything" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-input-request-kind="tool-approval"]')).toHaveCount(0);
  await page.screenshot({ path: "/tmp/open-agent-approval-takeover.png" });

  await approvalTakeover.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => responseBody).toMatchObject({
    inputResponses: [{ optionId: "approve", requestId: "request-child-bash" }],
  });
  await expect(page.getByText("The delegated task resumed and completed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Worked for/u })).toHaveCount(1);
  await page.getByRole("button", { name: /Worked for/ }).click();
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
  await page.reload();
  await expect(page.locator("[data-agent-approval-takeover]")).toHaveCount(0);
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

test("a half-open recovery stream is replaced when the durable run advances again", async ({ page }) => {
  const sessionId = "mock-half-open-recovery-session";
  const at = new Date().toISOString();
  const turnId = "turn_half_open_recovery";
  const durableEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at, id: "evt-recovery-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-recovery-turn" }, type: "turn.started" },
    { data: { message: "Keep recovering this long task", parts: [{ text: "Keep recovering this long task", type: "text" }], sequence: 0, turnId }, meta: { at, id: "evt-recovery-user" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-recovery-step-0" }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-recovery-message-0" }, type: "message.completed" },
    { data: { actions: [{ callId: "call-recovery", input: { command: "npm test" }, kind: "tool-call", toolName: "bash" }], sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-recovery-actions" }, type: "actions.requested" },
    {
      data: {
        result: { callId: "call-recovery", kind: "tool-result", output: "tests passed", toolName: "bash" },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId,
      },
      meta: { at, id: "evt-recovery-result" },
      type: "action.result",
    },
    { data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 10, outputTokens: 4 } }, meta: { at, id: "evt-recovery-step-completed-0" }, type: "step.completed" },
    { data: { sequence: 0, stepIndex: 1, turnId }, meta: { at, id: "evt-recovery-step-1" }, type: "step.started" },
    { data: { finishReason: "stop", message: "Recovery survived a second half-open stream.", sequence: 0, stepIndex: 1, turnId }, meta: { at, id: "evt-recovery-message-1" }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 1, turnId, usage: { inputTokens: 12, outputTokens: 5 } }, meta: { at, id: "evt-recovery-step-completed-1" }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-recovery-completed" }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at, id: "evt-recovery-waiting" }, type: "session.waiting" },
  ];

  await page.addInitScript(({ events, intermediateTail, targetSessionId }) => {
    const nativeFetch = window.fetch.bind(window);
    const browser = window as typeof window & {
      __openAgentRecoveryWatchdog?: {
        availableEvents: number;
        boundedRequests: number;
        liveRequests: number;
      };
    };
    browser.__openAgentRecoveryWatchdog = {
      availableEvents: 4,
      boundedRequests: 0,
      liveRequests: 0,
    };
    window.fetch = async (input, init) => {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        window.location.href,
      );
      if (requestUrl.pathname !== `/eve/v1/session/${targetSessionId}/stream`) {
        return await nativeFetch(input, init);
      }
      const state = browser.__openAgentRecoveryWatchdog!;
      const startIndex = Number(requestUrl.searchParams.get("startIndex") ?? "0");
      if (requestUrl.searchParams.get("includeTailIndex") === "1") {
        state.boundedRequests += 1;
        const available = events.slice(startIndex, state.availableEvents);
        return new Response(available.length > 0 ? `${available.map((event) => JSON.stringify(event)).join("\n")}\n` : "", {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-stream-tail-index": String(state.availableEvents - 1),
          },
          status: 200,
        });
      }

      state.liveRequests += 1;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = new ReadableStream({
        start(controller) {
          const endIndex = state.liveRequests === 1 ? 4 : intermediateTail;
          const prefix = events.slice(startIndex, endIndex);
          if (prefix.length > 0) {
            controller.enqueue(new TextEncoder().encode(
              `${prefix.map((event) => JSON.stringify(event)).join("\n")}\n`,
            ));
          }
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
        status: 200,
      });
    };
  }, { events: durableEvents, intermediateTail: 8, targetSessionId: sessionId });

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
  await composer.fill("Keep recovering this long task");
  await composer.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Thinking" })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __openAgentRecoveryWatchdog?: { liveRequests: number } })
      .__openAgentRecoveryWatchdog?.liveRequests ?? 0
  )).toBe(1);

  await page.evaluate((availableEvents) => {
    const browser = window as typeof window & {
      __openAgentRecoveryWatchdog?: { availableEvents: number };
    };
    if (browser.__openAgentRecoveryWatchdog) {
      browser.__openAgentRecoveryWatchdog.availableEvents = availableEvents;
    }
  }, 8);
  await page.waitForTimeout(16_000);
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __openAgentRecoveryWatchdog?: { liveRequests: number } })
      .__openAgentRecoveryWatchdog?.liveRequests ?? 0
  )).toBe(2);

  await page.evaluate((availableEvents) => {
    const browser = window as typeof window & {
      __openAgentRecoveryWatchdog?: { availableEvents: number };
    };
    if (browser.__openAgentRecoveryWatchdog) {
      browser.__openAgentRecoveryWatchdog.availableEvents = availableEvents;
    }
  }, durableEvents.length);
  await page.waitForTimeout(11_000);

  await expect(page.getByText("Recovery survived a second half-open stream.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect.poll(() => threadEvents(page).some((event) => isEventType(event, "session.waiting"))).toBeTruthy();
  const requestCounts = await page.evaluate(() =>
    (window as typeof window & {
      __openAgentRecoveryWatchdog?: { boundedRequests: number; liveRequests: number };
    }).__openAgentRecoveryWatchdog
  );
  expect(requestCounts?.liveRequests).toBe(2);
  expect(requestCounts?.boundedRequests).toBeGreaterThanOrEqual(4);
});

test("a hot cumulative file patch keeps the live diff responsive", async ({ page }) => {
  test.setTimeout(30_000);
  const sessionId = "mock-hot-file-patch-session";
  const turnId = "turn_hot_file_patch";
  const at = new Date().toISOString();
  const lines = Array.from({ length: 96 }, (_, index) => `+line-${index}`);
  const patchPrefix = "*** Begin Patch\n*** Update File: site.css\n@@\n";
  const patchSuffix = "\n*** End Patch";
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at, id: "evt-hot-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-hot-turn" }, type: "turn.started" },
    { data: { message: "Apply a large file patch", parts: [{ text: "Apply a large file patch", type: "text" }], sequence: 0, turnId }, meta: { at, id: "evt-hot-user" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-hot-step" }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-hot-message" }, type: "message.completed" },
    { data: { actions: [{ callId: "call-hot-patch", input: { patch: patchPrefix }, kind: "tool-call", toolName: "apply_patch" }], sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-hot-action" }, type: "actions.requested" },
    ...lines.map((_, index) => {
      const patch = `${patchPrefix}${lines.slice(0, index + 1).join("\n")}${index === lines.length - 1 ? patchSuffix : ""}`;
      return {
        data: {
          callId: "call-hot-patch",
          input: { patch },
          inputTextDelta: index === 0 ? JSON.stringify({ patch }) : "",
          inputTextSoFar: JSON.stringify({ patch }),
          sequence: index + 1,
          stepIndex: 0,
          toolName: "apply_patch",
          turnId,
        },
        meta: { at, id: `evt-hot-partial-${index}` },
        type: "action.input.partial",
      };
    }),
    { data: { result: { callId: "call-hot-patch", kind: "tool-result", output: { path: "site.css", applied: true }, toolName: "apply_patch" }, sequence: 97, status: "completed", stepIndex: 0, turnId }, meta: { at, id: "evt-hot-result" }, type: "action.result" },
    { data: { finishReason: "tool-calls", sequence: 98, stepIndex: 0, turnId, usage: { inputTokens: 10, outputTokens: 10 } }, meta: { at, id: "evt-hot-step-complete" }, type: "step.completed" },
    { data: { sequence: 99, stepIndex: 1, turnId }, meta: { at, id: "evt-hot-step-final" }, type: "step.started" },
    { data: { finishReason: "stop", message: "The file patch is complete.", sequence: 100, stepIndex: 1, turnId }, meta: { at, id: "evt-hot-final" }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 101, stepIndex: 1, turnId, usage: { inputTokens: 10, outputTokens: 5 } }, meta: { at, id: "evt-hot-final-step" }, type: "step.completed" },
    { data: { sequence: 102, turnId }, meta: { at, id: "evt-hot-complete" }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at, id: "evt-hot-waiting" }, type: "session.waiting" },
  ];

  await page.addInitScript(({ events: streamEvents, targetSessionId }) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url,
        window.location.href,
      );
      if (requestUrl.pathname !== `/eve/v1/session/${targetSessionId}/stream`) return await nativeFetch(input, init);
      const startIndex = Number(requestUrl.searchParams.get("startIndex") ?? "0");
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      let index = startIndex;
      const body = new ReadableStream({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException("Aborted", "AbortError"));
            return;
          }
          const event = streamEvents[index++];
          if (!event) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
    };
  }, { events, targetSessionId: sessionId });

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
  await composer.fill("Apply a large file patch");
  await composer.press("Enter");
  await page.getByRole("button", { name: "Worked for" }).click();
  await page.getByText("Edited site.css +96", { exact: true }).click();
  await expect(page.locator('[data-tool-view="diff"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-slot="diff-viewer-stats"]')).toContainText("+96", { timeout: 15_000 });
  await expect(page.getByText("The file patch is complete.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
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

  await page.route(`**/api/standalone/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ ok: true, state: "waiting", tailIndex: absoluteTailIndex }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      body: `${JSON.stringify(waiting)}\n`,
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

test("a settled Eve session never opens an unbounded recovery stream", async ({ page }) => {
  const sessionId = "mock-settled-session";
  const settledEvents = eventsFromNdjson(
    mockSuccessfulTurn("Recover a completed task", "This task was already complete."),
  );
  const projectedEvents = settledEvents.slice(0, 4);
  const streamRequests: string[] = [];

  await page.route(`**/api/standalone/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        ok: true,
        state: "waiting",
        tailIndex: settledEvents.length - 1,
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    streamRequests.push(url.search);
    await route.fulfill({
      body: ndjson(settledEvents.slice(Number(url.searchParams.get("startIndex") ?? "0"))),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(settledEvents.length - 1) },
      status: 200,
    });
  });

  const now = Date.now();
  setFakeThreadCollection(page, {
    activeThreadId: "settled-session-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: now,
      events: projectedEvents,
      id: "settled-session-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: projectedEvents.length },
      status: "submitted",
      title: "Settled task",
      updatedAt: now,
    }],
    version: 2,
  });

  await page.goto("/threads/settled-session-thread");
  await expect(page.getByText("This task was already complete.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(streamRequests.length).toBeGreaterThan(0);
  expect(streamRequests.every((search) => search.includes("includeTailIndex=1"))).toBeTruthy();
  expect(streamRequests.every((search) => !search.includes("follow=true"))).toBeTruthy();
});

test("a settled runtime clears a stale partial tool state", async ({ page }) => {
  const sessionId = "mock-settled-partial-session";
  const turnId = "turn_stale_partial";
  const at = new Date().toISOString();
  const settledEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at, id: "evt-partial-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-partial-turn" }, type: "turn.started" },
    { data: { message: "Finish the stale tool call", parts: [{ text: "Finish the stale tool call", type: "text" }], sequence: 0, turnId }, meta: { at, id: "evt-partial-user" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-partial-step" }, type: "step.started" },
    { data: { finishReason: "tool-calls", message: null, sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-partial-message" }, type: "message.completed" },
    { data: { actions: [{ callId: "call-partial", input: { patch: "*** Begin Patch\n*** Update File: index.html\n@@\n+done\n*** End Patch" }, kind: "tool-call", toolName: "apply_patch" }], sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-partial-action" }, type: "actions.requested" },
    { data: { callId: "call-partial", input: { patch: "*** Begin Patch\n*** Update File: index.html\n@@\n+done\n*** End Patch" }, sequence: 1, stepIndex: 0, toolName: "apply_patch", turnId }, meta: { at, id: "evt-partial-input" }, type: "action.input.partial" },
    { data: { result: { callId: "call-partial", kind: "tool-result", output: { applied: true, path: "index.html" }, toolName: "apply_patch" }, sequence: 2, status: "completed", stepIndex: 0, turnId }, meta: { at, id: "evt-partial-result" }, type: "action.result" },
    { data: { finishReason: "tool-calls", sequence: 3, stepIndex: 0, turnId, usage: { inputTokens: 10, outputTokens: 10 } }, meta: { at, id: "evt-partial-step-complete" }, type: "step.completed" },
    { data: { sequence: 4, stepIndex: 1, turnId }, meta: { at, id: "evt-partial-final-step" }, type: "step.started" },
    { data: { finishReason: "stop", message: "The stale tool call is complete.", sequence: 5, stepIndex: 1, turnId }, meta: { at, id: "evt-partial-final" }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 6, stepIndex: 1, turnId, usage: { inputTokens: 10, outputTokens: 5 } }, meta: { at, id: "evt-partial-final-step-complete" }, type: "step.completed" },
    { data: { sequence: 7, turnId }, meta: { at, id: "evt-partial-turn-complete" }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, meta: { at, id: "evt-partial-waiting" }, type: "session.waiting" },
  ];
  const projectedEvents = settledEvents.slice(0, 7);
  const streamRequests: string[] = [];

  await page.route(`**/api/standalone/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify({ ok: true, state: "waiting", tailIndex: settledEvents.length - 1 }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    streamRequests.push(url.search);
    await route.fulfill({
      body: ndjson(settledEvents.slice(Number(url.searchParams.get("startIndex") ?? "0"))),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(settledEvents.length - 1) },
      status: 200,
    });
  });

  const now = Date.now();
  setFakeThreadCollection(page, {
    activeThreadId: "settled-partial-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: now,
      events: projectedEvents,
      id: "settled-partial-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: projectedEvents.length },
      status: "submitted",
      title: "Stale partial tool",
      updatedAt: now,
    }],
    version: 2,
  });

  await page.goto("/threads/settled-partial-thread");
  await expect(page.getByText("The stale tool call is complete.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByText("Editing", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
  expect(streamRequests.length).toBeGreaterThan(0);
  expect(streamRequests.every((search) => search.includes("includeTailIndex=1"))).toBeTruthy();
  expect(streamRequests.every((search) => !search.includes("follow=true"))).toBeTruthy();
});

test("recovery rewinds a transport cursor that advanced past the UI transcript", async ({ page }) => {
  const sessionId = "mock-polluted-cursor-session";
  const durableEvents = eventsFromNdjson(
    mockSuccessfulTurn("Recover every durable event", "No durable event was skipped."),
  ).map((event, index) => {
    if (!isRecord(event)) return event;
    return { ...event, meta: { ...(isRecord(event.meta) ? event.meta : {}), id: `evt-polluted-${index}` } };
  });
  const observedEvents = durableEvents.slice(0, 4);
  const pollutedCursor = durableEvents.length + 12;
  const requestedStarts: number[] = [];

  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    requestedStarts.push(startIndex);
    await route.fulfill({
      body: ndjson(startIndex < 0 ? durableEvents.slice(-1) : durableEvents.slice(startIndex)),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(durableEvents.length - 1) },
      status: 200,
    });
  });

  const now = Date.now();
  setFakeThreadCollection(page, {
    activeThreadId: "polluted-cursor-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: now,
      events: observedEvents,
      id: "polluted-cursor-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: pollutedCursor },
      status: "streaming",
      title: "Polluted cursor",
      updatedAt: now,
    }],
    version: 2,
  });

  await page.goto("/threads/polluted-cursor-thread");
  await expect(page.getByText("No durable event was skipped.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(requestedStarts).toContain(0);
  expect(requestedStarts).toContain(observedEvents.length);
  await expect.poll(() => firstStoredThread(page)?.session?.streamIndex).toBe(durableEvents.length);
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

test("recovery does not unlock at turn.completed before session.waiting", async ({ page }) => {
  const sessionId = "mock-turn-boundary-session";
  const at = new Date().toISOString();
  const turnId = "turn_recovery_boundary";
  const prefix = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at, id: "evt-boundary-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-boundary-turn" }, type: "turn.started" },
    { data: { message: "Wait for the durable boundary", parts: [{ text: "Wait for the durable boundary", type: "text" }], sequence: 0, turnId }, meta: { at, id: "evt-boundary-user" }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-boundary-step" }, type: "step.started" },
  ];
  const completed = [
    { data: { finishReason: "stop", message: "The model turn is complete.", sequence: 0, stepIndex: 0, turnId }, meta: { at, id: "evt-boundary-message" }, type: "message.completed" },
    { data: { finishReason: "stop", sequence: 0, stepIndex: 0, turnId, usage: { inputTokens: 2, outputTokens: 2 } }, meta: { at, id: "evt-boundary-step-complete" }, type: "step.completed" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-boundary-turn-complete" }, type: "turn.completed" },
  ];
  const waiting = {
    data: { wait: "next-user-message" },
    meta: { at, id: "evt-boundary-waiting" },
    type: "session.waiting",
  };
  let waitingVisible = false;
  let releaseWaiting: (() => void) | undefined;
  const waitingReleased = new Promise<void>((resolve) => {
    releaseWaiting = () => {
      waitingVisible = true;
      resolve();
    };
  });

  await page.route(`**/api/standalone/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      body: JSON.stringify(waitingVisible
        ? { ok: true, state: "waiting", tailIndex: prefix.length + completed.length }
        : { ok: true, state: "running", tailIndex: prefix.length + completed.length - 1 }),
      contentType: "application/json",
      status: 200,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    const current = [...prefix, ...completed];
    if (startIndex < current.length) {
      await route.fulfill({
        body: ndjson(current.slice(startIndex)),
        contentType: "application/x-ndjson",
        headers: { "x-eve-stream-tail-index": String(current.length - 1) },
        status: 200,
      });
      return;
    }
    await waitingReleased;
    await route.fulfill({
      body: `${JSON.stringify(waiting)}\n`,
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(current.length) },
      status: 200,
    });
  });

  const now = Date.now();
  setFakeThreadCollection(page, {
    activeThreadId: "turn-boundary-thread",
    threads: [{
      closedInputRequestIds: [],
      createdAt: now,
      events: prefix,
      id: "turn-boundary-thread",
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: prefix.length },
      status: "streaming",
      title: "Durable boundary",
      updatedAt: now,
    }],
    version: 2,
  });

  await page.goto("/threads/turn-boundary-thread");
  await expect(page.getByText("The model turn is complete.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  releaseWaiting?.();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => threadEvents(page).some((event) => isEventType(event, "session.waiting"))).toBeTruthy();
});

test("stop keeps the composer locked until the durable cancellation boundary settles", async ({ page }) => {
  const sessionId = "mock-cancel-session";
  let releaseBoundary: (() => void) | undefined;
  let cancelledTurnId: string | undefined;
  const boundaryReleased = new Promise<void>((resolve) => {
    releaseBoundary = resolve;
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
    await boundaryReleased;
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

  await expect(page.getByRole("button", { name: "Stopping", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeHidden();
  await expect.poll(() => cancelledTurnId).toBe("turn_0");
  // The cancel HTTP response is only an accepted command. The old client
  // released the composer here, which allowed a new turn to race the active
  // server turn. Keep it locked until turn.cancelled -> session.waiting.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeHidden();
  releaseBoundary?.();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(cancelledTurnId).toBe("turn_0");
});

test("a recovering cancellation never revives late output from the interrupted turn", async ({ page }) => {
  const threadId = "recovering-cancellation-freeze-thread";
  const sessionId = "mock-recovering-cancellation-freeze-session";
  const turnId = "turn_cancel_freeze";
  const at = new Date().toISOString();
  const initialEvents = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at, id: "evt-freeze-session" }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at, id: "evt-freeze-turn" }, type: "turn.started" },
    { data: { message: "Stop this work", parts: [{ text: "Stop this work", type: "text" }], sequence: 0, turnId }, meta: { at, id: "evt-freeze-user" }, type: "message.received" },
  ];
  const lateEvent = {
    data: { messageDelta: "LATE", messageSoFar: "LATE OUTPUT MUST STAY HIDDEN", sequence: 0, stepIndex: 0, turnId },
    meta: { at, id: "evt-freeze-late" },
    type: "message.appended",
  } as const;
  const cancelledEvent = {
    data: { sequence: 0, turnId },
    meta: { at, id: "evt-freeze-cancelled" },
    type: "turn.cancelled",
  } as const;
  const waitingEvent = {
    data: { wait: "next-user-message" },
    meta: { at, id: "evt-freeze-waiting" },
    type: "session.waiting",
  } as const;
  let lateCatchUpServed = false;
  let cancelRequests = 0;
  let releaseCancellation: (() => void) | undefined;
  const cancellationReleased = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });

  setFakeThreadCollection(page, {
    activeThreadId: threadId,
    threads: [{
      closedInputRequestIds: [],
      createdAt: Date.now(),
      events: initialEvents,
      id: threadId,
      interruptedTurns: [{ eventCount: initialEvents.length, streamIndex: initialEvents.length, turnId }],
      preferences: { executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium" },
      queuedTurns: [],
      session: { sessionId, streamIndex: initialEvents.length },
      status: "cancelling",
      title: "Cancellation freeze",
      updatedAt: Date.now(),
    }],
    version: 2,
  });
  await page.route(`**/eve/v1/session/${sessionId}/cancel`, async (route) => {
    cancelRequests += 1;
    await route.fulfill({
      body: JSON.stringify({ ok: true, sessionId, status: "accepted" }),
      contentType: "application/json",
      status: 202,
    });
  });
  await page.route(`**/eve/v1/session/${sessionId}/stream**`, async (route) => {
    const url = new URL(route.request().url());
    const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
    if (url.searchParams.has("includeTailIndex") && startIndex === initialEvents.length) {
      lateCatchUpServed = true;
      await route.fulfill({
        body: ndjson([lateEvent]),
        contentType: "application/x-ndjson",
        headers: { "x-eve-stream-tail-index": String(initialEvents.length) },
        status: 200,
      });
      return;
    }
    await cancellationReleased;
    const tail = [lateEvent, cancelledEvent, waitingEvent];
    await route.fulfill({
      body: ndjson(tail.slice(Math.max(0, startIndex - initialEvents.length))),
      contentType: "application/x-ndjson",
      headers: { "x-eve-stream-tail-index": String(initialEvents.length + tail.length - 1) },
      status: 200,
    });
  });

  await page.goto(`/threads/${threadId}`);
  await expect.poll(() => lateCatchUpServed).toBeTruthy();
  await expect.poll(() => cancelRequests).toBeGreaterThan(0);
  await expect(page.getByText("LATE OUTPUT MUST STAY HIDDEN", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect.poll(() => firstStoredThread(page)?.status).toBe("cancelling");

  releaseCancellation?.();
  await expect.poll(() => firstStoredThread(page)?.status).toBe("ready");
  await expect(page.getByText("LATE OUTPUT MUST STAY HIDDEN", { exact: true })).toHaveCount(0);
  const storedEvents = firstStoredThread(page)?.events;
  expect(JSON.stringify(storedEvents)).not.toContain("LATE OUTPUT MUST STAY HIDDEN");
});

test("a follow-up waits until cancellation settles before becoming the next normal turn", async ({ page }) => {
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
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);

  // The composer remains locked while Eve has only acknowledged the cancel.
  // Release the durable boundary before admitting the follow-up.
  releaseCancellation?.();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await composer.fill("Continue as a normal turn");
  await composer.press("Enter");
  await expect(page.getByText("Continue as a normal turn", { exact: true })).toBeVisible();
  await expect(page.locator("[data-agent-steer-queue]")).toBeHidden();
  expect(mailboxEnqueues).toBe(0);

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
  // The cancelled event is not the final admission boundary. The composer is
  // released only after session.waiting arrives.
  await page.evaluate(() => {
    const release = Reflect.get(window, "__openAgentReleaseRecoveryBoundary");
    if (typeof release === "function") release();
  });
  const composer = page.getByRole("textbox", { name: "Do anything" });
  await composer.fill("Continue after the boundary");
  await composer.press("Enter");
  await expect(page.getByText("Continue after the boundary", { exact: true })).toBeVisible();

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

  await expect(page.getByRole("button", { name: "Stopping", exact: true })).toBeVisible();
  await expect.poll(() => cancellations.some((entry) => entry.turnId === turnId)).toBeTruthy();
  expect(cancellations[0]?.turnId).toBeUndefined();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
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

  // No Eve session has been admitted yet, so this is a local-only stop and
  // the composer can return immediately without racing a server turn.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
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
    if (url.searchParams.has("includeTailIndex")) {
      boundedTailRequests += 1;
    }
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
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect.poll(() => cancelRequested).toBeTruthy();
  await expect.poll(() => firstStoredThread(page)?.status).toBe("cancelling");
  releaseStreams?.();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
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

function mockProviderFailureTurn(message: string): string {
  const at = new Date().toISOString();
  const turnId = "turn_provider_failure";
  const events = [
    { data: { runtime: { agentId: "open-agent", agentName: "open-agent", eveVersion: "test", modelId: "mock/model" } }, meta: { at }, type: "session.started" },
    { data: { sequence: 0, turnId }, meta: { at }, type: "turn.started" },
    { data: { message, parts: [{ text: message, type: "text" }], sequence: 0, turnId }, meta: { at }, type: "message.received" },
    { data: { sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "step.started" },
    { data: { code: "MODEL_CALL_FAILED", message: "The model Provider request timed out.", sequence: 0, stepIndex: 0, turnId }, meta: { at }, type: "step.failed" },
    { data: { code: "MODEL_CALL_FAILED", message: "The model Provider request timed out.", sequence: 0, turnId }, meta: { at }, type: "turn.failed" },
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
