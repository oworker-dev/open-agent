import { expect, test } from "@playwright/test";
import { NativeFixture, line, reply, startTurn } from "./native-fixture.ts";
import { wireLines } from "../helpers/session-events.ts";
import { applyThreadCollectionPatch, parseThreadCollectionPatch, summarizeThreadCollection } from "../../server/http/thread-collection-contract.ts";
import type { AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";

test("slow history restoration shows loading and reaches the bottom after message rows commit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = new NativeFixture(page); fixture.seed(35); await fixture.install();
  const checkpoint = { ...fixture.collection, threads: fixture.collection.threads.map(thread => ({ ...thread, events: thread.events.slice(-2) })) };
  fixture.collection = checkpoint;
  let release = Promise.withResolvers<void>();
  fixture.onRead = async (start) => { if (start === 0) await release.promise; };
  const viewport = page.locator('[data-slot="thread-viewport"]');
  const bottomGap = () => viewport.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  for (const refresh of [false, true]) {
    if (refresh) {
      await viewport.hover(); await page.mouse.wheel(0, -2000);
      await expect.poll(bottomGap).toBeGreaterThan(100);
      fixture.collection = checkpoint;
      release = Promise.withResolvers<void>();
      await page.reload({ waitUntil: "domcontentloaded" });
    } else await page.goto("/threads/native-thread", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-agent-history-loading]")).toBeVisible();
    await expect(page.getByRole("heading", { name: "What should we work on?", exact: true })).toHaveCount(0);
    release.resolve();
    await expect(viewport.getByText("History reply 34", { exact: true })).toHaveCount(1);
    await expect.poll(bottomGap).toBeLessThan(2);
  }
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  await page.locator("aside").getByText("Native history", { exact: true }).click();
  await expect(viewport.getByText("History reply 34", { exact: true })).toHaveCount(1);
  await expect.poll(bottomGap).toBeLessThan(2);
});

for (const incomplete of [false, true]) test(`only complete source history skips full replay (incomplete=${incomplete})`, async ({ page }) => {
  const fixture = new NativeFixture(page); fixture.seed(10); await fixture.install();
  if (incomplete) fixture.collection = { ...fixture.collection, threads: fixture.collection.threads.map(thread => ({ ...thread, events: thread.events.filter((_, index) => index !== 3) })) };
  const starts: number[] = [];
  fixture.onRead = async (start) => { starts.push(start); };
  await page.goto("/threads/native-thread");
  await expect(page.getByText("History reply 9", { exact: true })).toHaveCount(1);
  await expect.poll(() => starts.length).toBeGreaterThan(0);
  expect(starts[0]).toBe(incomplete ? 0 : fixture.cursor);
});

test("reading saved history during catch-up cancels the initial bottom-follow intent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = new NativeFixture(page); fixture.seed(35); await fixture.install();
  fixture.events.push(...startTurn(fixture.cursor, "latest", "latest-delivery", "Latest request", "history-34"));
  fixture.events.push(...reply(fixture.cursor, "latest", "latest-delivery", "Latest reply"));
  const release = Promise.withResolvers<void>();
  fixture.onRead = async () => release.promise;
  await page.goto("/threads/native-thread");
  const viewport = page.locator('[data-slot="thread-viewport"]');
  await expect(viewport.getByText("History reply 34", { exact: true })).toHaveCount(1);
  await viewport.hover(); await page.mouse.wheel(0, -1800);
  await expect.poll(() => viewport.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(500);
  const readingTop = await viewport.evaluate(el => el.scrollTop);
  release.resolve();
  await expect(viewport.getByText("Latest reply", { exact: true })).toHaveCount(1);
  await page.waitForTimeout(150);
  expect(Math.abs(await viewport.evaluate(el => el.scrollTop) - readingTop)).toBeLessThan(3);
});

test("sub-agent tools open named children in the side view and closing failures remain retryable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = new NativeFixture(page); fixture.seed(2); await fixture.install();
  fixture.events.push(...startTurn(fixture.cursor, "delegate", "delegate-delivery", "Delegate a test task", "history-1"));
  fixture.events.push(...line(fixture.cursor,
    { type: "call.requested", scope: { turnId: "delegate" }, data: { callId: "child-call", owner: { runId: "delegate:run" }, capability: { kind: "agent", name: "agent" }, input: { message: "Investigate" } } },
    { type: "task.started", data: { taskId: "child-task", kind: "agent", name: "agent", startedBy: { callId: "child-call" } } },
    { type: "call.started", scope: { turnId: "delegate" }, data: { callId: "child-call", taskId: "child-task" } },
    { type: "child.opened", scope: { turnId: "delegate" }, data: { sessionId: "audit-child", owner: { taskId: "child-task" }, name: "agent", stream: "/eve/v1/session/audit-child/stream" } },
    { type: "call.settled", data: { callId: "child-call", outcome: "completed", output: "Reviewed" } }));
  fixture.events.push(...line(fixture.cursor,
    { type: "call.requested", scope: { turnId: "delegate" }, data: { callId: "continued-call", owner: { runId: "delegate:run" }, capability: { kind: "agent", name: "agent" }, input: { taskId: "child-task", message: "Review again", nickname: "Changed" } } },
    { type: "call.started", data: { callId: "continued-call", taskId: "child-task" } }));
  let child = { childSessionId: "audit-child", callId: "child-call", name: "agent", nickname: "Atlas", status: "waiting" };
  let childMetadataGate: Promise<void> | undefined;
  await page.route("**/api/standalone/sessions/native-fixture-session/subagents", async route => {
    await childMetadataGate;
    return route.fulfill({ json: { ok: true, children: [child] } });
  });
  const actions: string[] = [];
  await page.route("**/api/standalone/subagents/audit-child", async route => {
    actions.push(route.request().postDataJSON().action);
    if (actions.length === 1) return route.fulfill({ status: 502, json: { error: "Controlled close failure" } });
    child = { ...child, status: "closed" };
    await route.fulfill({ json: { ok: true, subagent: child } });
  });
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "child", "child-delivery", "Child task"), ...reply(4, "child", "child-delivery", "Child reply")];
  await page.route("**/eve/v1/session/audit-child/stream*", route => {
    const start = Number(new URL(route.request().url()).searchParams.get("startIndex") ?? 0);
    return route.fulfill({ body: wireLines(events.filter(event => event.meta.position.line >= start)), headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "27", "x-eve-stream-tail-index": "4" } });
  });
  // Child snapshots use their own storage key, as they do on the server.
  let childCollection: AgentThreadCollection = { version: 2, threads: [] };
  let childRevision = 0;
  await page.route("**/api/standalone/thread-collections/*%3Asubagent%3Aaudit-child*", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") return route.fulfill({ json: url.searchParams.get("view") === "index"
      ? { collection: summarizeThreadCollection(childCollection), revision: childRevision }
      : { thread: childCollection.threads.find(thread => thread.id === "audit-child") ?? null, revision: childRevision } });
    const patch = parseThreadCollectionPatch(request.postDataJSON());
    if (!patch) return route.fulfill({ status: 400 });
    childCollection = applyThreadCollectionPatch(childCollection, patch);
    return route.fulfill({ json: { ok: true, revision: ++childRevision }, headers: { etag: `"${childRevision}"` } });
  });
  await page.goto("/threads/native-thread");
  await expect(page.getByRole("button", { name: "Open sub-agents", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sub-agent · Atlas/ })).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Sub-agent · Changed/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Sub-agent · Atlas/ }).last().click();
  await page.getByRole("button", { name: "Open sub-agent session", exact: true }).last().click();
  const side = page.locator("[data-agent-secondary-view]");
  await expect(side.getByText("Child reply", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="agent-workbench"]').getByText("Delegate a test task", { exact: true })).toBeVisible();
  await side.getByRole("button", { name: "Back to list", exact: true }).click();
  await side.getByRole("button", { name: "Close sub-agent Atlas", exact: true }).click();
  await expect(side.getByRole("alert")).toContainText("Subagent control request failed");
  await side.getByRole("button", { name: "Close sub-agent Atlas", exact: true }).click();
  await expect(side.getByText("Closed", { exact: true })).toBeVisible();
  expect(actions).toEqual(["close", "close"]);
  await expect(side.getByRole("button", { name: "Close sub-agent Atlas", exact: true })).toHaveCount(0);
  await side.getByRole("button", { name: /Atlas.*Closed/ }).click();
  await expect(side.getByRole("textbox", { name: "Do anything" })).toHaveCount(0);
  await side.getByRole("button", { name: "Close Atlas", exact: true }).click();
  await expect(side.getByText("Child reply", { exact: true })).toHaveCount(0);
  childCollection = { ...childCollection, threads: childCollection.threads.map(thread => ({
    ...thread,
    queuedTurns: [{ id: "old-followup", text: "Old queued follow-up", state: "queued", delivery: "server", submittedAt: Date.now() }],
    inputResponseSubmissions: [{ id: "old-answer", responses: [{ interactionId: "old-question", text: "Old answer" }], state: "submitting", streamIndexAtSubmission: 5, submittedAt: Date.now() }],
  })) };
  const childMetadata = Promise.withResolvers<void>();
  childMetadataGate = childMetadata.promise;
  await page.goto("/threads/native-thread/agents/audit-child");
  await expect(side.getByText("Child reply", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="agent-workbench"]').getByText("Delegate a test task", { exact: true })).toBeVisible();
  await expect(side.getByRole("textbox", { name: "Do anything" })).toHaveCount(0);
  await expect(side.locator("[data-agent-steer-queue]")).toHaveCount(0);
  childMetadata.resolve();
  await expect(side.getByRole("button", { name: "Close Atlas", exact: true })).toBeVisible();
  await page.waitForTimeout(150);
  expect(fixture.edits).toHaveLength(0);
});
