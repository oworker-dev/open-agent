import { expect, test, type Frame, type Page } from "@playwright/test";
import type { AgentEmbedConfigureMessage, AgentEmbedEvent } from "@oworker/open-agent-contracts/embed";
import { NativeFixture, line, reply, startTurn } from "./native-fixture.ts";

const hostUrl = "http://127.0.0.1:4730/open-agent-embed-test";
const serviceUrl = process.env.AGENT_WEB_URL ?? "http://127.0.0.1:3000";
const configuration: AgentEmbedConfigureMessage = {
  type: "agent.embed.configure", contractVersion: "0.1.0", requestId: "initial",
  accessToken: "synthetic-initial-token", expiresAt: new Date(Date.now() + 300_000).toISOString(),
  serviceUrl, storageKey: "embed-test:project-a", profile: { id: "default", version: "1" }, locale: "en",
};

type Host = typeof window & {
  embedEvents: AgentEmbedEvent[];
  configure(value: AgentEmbedConfigureMessage): void;
};
type StreamStats = typeof window & { __nativeEve: { stats: { starts: number; aborts: number } } };

async function openEmbed(page: Page, config = configuration) {
  let navigations = 0;
  const requests: { method: string; url: string; authorization?: string; policy?: string }[] = [];
  page.on("framenavigated", frame => { if (frame.url().startsWith(`${serviceUrl}/embed`)) navigations++; });
  page.on("request", request => {
    if (request.url().startsWith(serviceUrl)) requests.push({
      method: request.method(), url: request.url(), authorization: request.headers().authorization,
      policy: request.headers()["x-agent-run-policy"],
    });
  });
  await page.route(hostUrl, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <html><body style="margin:0"><script>
    window.embedEvents = [];
    window.configuration = ${JSON.stringify(config)};
    window.configure = value => {
      window.configuration = value;
      document.querySelector('iframe').contentWindow.postMessage(value, ${JSON.stringify(serviceUrl)});
    };
    addEventListener('message', event => {
      if (event.origin !== ${JSON.stringify(serviceUrl)} || event.source !== document.querySelector('iframe').contentWindow) return;
      window.embedEvents.push(event.data);
      if (event.data.type === 'agent.embed.ready') window.configure(window.configuration);
    });
    </script><iframe src="${serviceUrl}/embed" style="border:0;width:100vw;height:100vh"></iframe></body></html>` }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(["local-network-access"], { origin: new URL(hostUrl).origin });
  await page.goto(hostUrl);
  await expect.poll(() => page.evaluate(() => (window as Host).embedEvents.some(event => event.type === "agent.embed.configured"))).toBe(true);
  const frame = page.frames().find(frame => frame.url().startsWith(`${serviceUrl}/embed`))!;
  await expect(frame.getByRole("textbox", { name: "Do anything" })).toBeVisible();
  return {
    frame, requests, navigations: () => navigations,
    indexLoads: (storageKey?: string) => requests.filter(request => request.method === "GET" && request.url.includes("/thread-collections/") && new URL(request.url).searchParams.get("view") === "index" && (!storageKey || decodeURIComponent(new URL(request.url).pathname).endsWith(`/${storageKey}`))).length,
    async configure(patch: Partial<AgentEmbedConfigureMessage> = {}) {
      const next = { ...config, requestId: `rotation-${Date.now()}`, accessToken: "synthetic-renewed-token", expiresAt: new Date(Date.now() + 600_000).toISOString(), ...patch };
      await page.evaluate(value => (window as Host).configure(JSON.parse(value)), JSON.stringify(next));
      await expect.poll(() => page.evaluate(id => (window as Host).embedEvents.some(event => event.type === "agent.embed.configured" && event.requestId === id), next.requestId)).toBe(true);
      // Let configure's React commit and its effects finish before asserting stability.
      await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    },
  };
}

async function send(frame: Frame, text: string) {
  const composer = frame.getByRole("textbox", { name: "Do anything" });
  await composer.fill(text); await composer.press("Enter");
  await expect(frame.getByRole("log").getByText(text, { exact: true })).toHaveCount(1);
}

test("token renewal retains the selected transcript and draft without loading the collection again", async ({ page }) => {
  const f = new NativeFixture(page, "agent"); f.seed(); await f.install();
  const h = await openEmbed(page);
  // Selecting explicitly also exercises the old implementation's renewal bug independently of initial restoration.
  await h.frame.getByRole("button", { name: "Native history", exact: true }).click();
  await expect(h.frame.getByText("History reply 0", { exact: true })).toBeVisible();
  await h.frame.getByRole("textbox", { name: "Do anything" }).fill("A draft that must survive renewal");
  const loads = h.indexLoads();
  const navigations = h.navigations();
  await h.configure();
  expect(h.indexLoads()).toBe(loads);
  expect(h.navigations()).toBe(navigations);
  await expect(h.frame.locator('aside [aria-current="page"]')).toHaveText("Native history");
  await expect(h.frame.getByText("History reply 0", { exact: true })).toBeVisible();
  await expect(h.frame.getByRole("textbox", { name: "Do anything" })).toHaveText("A draft that must survive renewal");
});

test("renewal keeps an active stream and later requests read the latest token, policy, and client context", async ({ page }) => {
  const f = new NativeFixture(page, "agent"); await f.install();
  const h = await openEmbed(page);
  f.onSend = async body => { await f.publish(startTurn(f.cursor, "running", "running-delivery", String(body.message)), h.frame); };
  await send(h.frame, "Keep generating");
  await expect(h.frame.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const streams = await h.frame.evaluate(() => ({ ...(window as StreamStats).__nativeEve.stats }));
  expect(streams.starts).toBeGreaterThan(0);
  const loads = h.indexLoads();
  await h.configure({ clientContext: { canvas: "latest" }, runPolicy: { tools: ["bash"] } });
  expect(await h.frame.evaluate(() => (window as StreamStats).__nativeEve.stats)).toEqual(streams);
  expect(h.indexLoads()).toBe(loads);
  await expect(h.frame.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await f.publish(reply(f.cursor, "running", "running-delivery", "The same stream still delivers"), h.frame);
  await expect(h.frame.getByText("The same stream still delivers", { exact: true })).toBeVisible();
  f.onSend = undefined;
  await send(h.frame, "Use renewed credentials");
  await expect.poll(() => f.sends.length).toBe(2);
  expect(f.sends.at(-1)?.clientContext).toEqual({ canvas: "latest" });
  const sendRequest = h.requests.filter(request => request.method === "POST" && request.url.endsWith(`/eve/v1/session/${f.sessionId}`)).at(-1);
  expect(sendRequest?.authorization).toBe("Bearer synthetic-renewed-token");
  expect(sendRequest?.policy).toBe(Buffer.from(JSON.stringify({ tools: ["bash"] })).toString("base64url"));
  await expect.poll(() => h.requests.some(request => request.method === "PATCH" && request.authorization === "Bearer synthetic-renewed-token")).toBe(true);
});

test("renewal preserves pending approval and submits its answer with the renewed token", async ({ page }) => {
  const f = new NativeFixture(page, "agent"); await f.install();
  const h = await openEmbed(page);
  f.onSend = async body => {
    await f.publish(startTurn(f.cursor, "approval", "approval-delivery", String(body.message)), h.frame);
    await f.publish(line(f.cursor,
      { type: "call.requested", scope: { turnId: "approval" }, data: { callId: "pending-write", owner: { runId: "approval:run" }, capability: { kind: "tool", name: "host_invoke" }, input: { capability: "canvas.patch" } } },
      { type: "model.settled", scope: { turnId: "approval" }, data: { runId: "approval:run", outcome: "completed", finishReason: "tool-calls" } },
      { type: "interaction.opened", scope: { turnId: "approval" }, data: { interactionId: "write-approval", subject: { callId: "pending-write" }, request: { kind: "approval", prompt: "Write to the canvas?" } } },
      { type: "turn.paused", data: { turnId: "approval", awaiting: [{ interactionId: "write-approval" }] } },
    ), h.frame);
  };
  await send(h.frame, "Ask before writing");
  const approval = h.frame.locator("[data-agent-approval-takeover]");
  await expect(approval).toBeVisible();
  f.onSend = undefined;
  const loads = h.indexLoads();
  await h.configure();
  expect(h.indexLoads()).toBe(loads);
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => f.edits.length).toBe(1);
  expect(f.edits[0]?.inputResponses).toEqual([{ interactionId: "write-approval", optionId: "approve" }]);
  expect(h.requests.filter(request => request.method === "POST" && request.url.endsWith("/api/agent/mailbox")).at(-1)?.authorization).toBe("Bearer synthetic-renewed-token");
});

test("embed refresh restores the persisted active thread, and renewal preserves a recent selection", async ({ page }) => {
  const f = new NativeFixture(page, "agent"); f.seed();
  const original = f.collection.threads[0]!;
  f.collection = { ...f.collection, threads: [{ ...original, id: "other-thread", title: "Other session", events: [], session: { streamIndex: 0 } }, original] };
  await f.install();
  const h = await openEmbed(page);
  await expect(h.frame.getByText("History reply 0", { exact: true })).toBeVisible();
  await h.frame.getByRole("button", { name: "Other session", exact: true }).click();
  await h.configure();
  await expect(h.frame.locator('aside [aria-current="page"]')).toHaveText("Other session");
  await expect.poll(() => f.collection.activeThreadId).toBe("other-thread");
  await h.frame.evaluate(() => location.reload());
  await expect(h.frame.locator('aside [aria-current="page"]')).toHaveText("Other session");
  await expect(h.frame.locator("aside").getByText("New session", { exact: true })).toHaveCount(1);
});

test("a missing persisted active ID selects an existing thread, while a new scope resets the workspace", async ({ page }) => {
  const f = new NativeFixture(page, "agent"); f.seed();
  f.collection = { ...f.collection, activeThreadId: "deleted-thread" }; await f.install();
  const h = await openEmbed(page);
  await expect(h.frame.getByText("History reply 0", { exact: true })).toBeVisible();
  await h.frame.getByRole("textbox", { name: "Do anything" }).fill("Project A private draft");
  f.collection = { threads: [], version: 2 }; f.revision = 0;
  const initialLoads = h.indexLoads(configuration.storageKey);
  await h.configure({ storageKey: "embed-test:project-b", accessToken: "synthetic-project-b-token" });
  // Development Strict Mode replays mount effects. A new scope should perform
  // the same initialization as the first scope in either dev or production.
  await expect.poll(() => h.indexLoads("embed-test:project-b")).toBe(initialLoads);
  await expect(h.frame.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
  await expect(h.frame.getByRole("textbox", { name: "Do anything" })).toHaveText("");
  await expect(h.frame.getByText("History reply 0", { exact: true })).toHaveCount(0);
});
