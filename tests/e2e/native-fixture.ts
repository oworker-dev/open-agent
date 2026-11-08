import { expect, type Frame, type Page } from "@playwright/test";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { activeTurn, idle } from "eve/events";
import { applyThreadCollectionPatch, parseThreadCollectionPatch, summarizeThreadCollection } from "../../server/http/thread-collection-contract.ts";
import { parseThreadCollection, type AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";
import { eveEventsCursor } from "../../lib/eve-stream.ts";
import { line, reply, startTurn, wireLines } from "../helpers/session-events.ts";

export { line, reply, startTurn };
export class NativeFixture {
  readonly sessionId = "native-fixture-session";
  collection: AgentThreadCollection = { threads: [], version: 2 };
  events: SessionStreamEvent[] = line(0, { type: "session.started", data: {} });
  revision = 0;
  conflictsRemaining = 0;
  sendCount = 0;
  sends: Record<string, unknown>[] = [];
  cancellations: (string | undefined)[] = [];
  edits: Record<string, unknown>[] = [];
  mailboxStatus = "accepted";
  onSend?: (body: Record<string, unknown>) => Promise<void>;
  onEdit?: (body: Record<string, unknown>) => Promise<void>;
  onCancel?: (turnId?: string) => Promise<void>;
  page: Page;
  constructor(page: Page, readonly namespace: "standalone" | "agent" = "standalone") { this.page = page; }
  get cursor() { return eveEventsCursor(this.events); }
  async install() {
    const { page } = this;
    await page.exposeBinding("__readNativeEve", (_source, start: number) => ({
      body: wireLines(this.events.filter((event) => event.meta.position.line >= start)), tail: this.cursor - 1,
    }));
    await page.addInitScript(({ sessionId }) => {
      type Connection = { cursor: number; controller: ReadableStreamDefaultController<Uint8Array> };
      const streams = new Set<Connection>();
      const encoder = new TextEncoder();
      const originalFetch = window.fetch.bind(window);
      const browser = window as typeof window & {
        __readNativeEve(start: number): Promise<{ body: string; tail: number }>;
        __nativeEve: { push(body: string, tail: number): void; disconnect(): void; stats: { starts: number; aborts: number } };
      };
      const withoutEnd = (body: string) => body.replace('{"$eve":"stream.ended"}\n', "");
      browser.__nativeEve = {
        stats: { starts: 0, aborts: 0 },
        push(body, tail) {
          for (const stream of streams) {
            stream.controller.enqueue(encoder.encode(withoutEnd(body)));
            stream.cursor = tail + 1;
          }
        },
        disconnect() { for (const stream of streams) stream.controller.close(); streams.clear(); },
      };
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.pathname !== `/eve/v1/session/${sessionId}/stream`) return originalFetch(input, init);
        const start = Number(url.searchParams.get("startIndex") ?? 0);
        const snapshot = await browser.__readNativeEve(start);
        const headers = { "content-type": "application/x-ndjson", "x-eve-stream-version": "27", "x-eve-stream-tail-index": String(snapshot.tail) };
        if (url.searchParams.get("follow") === "false") return new Response(snapshot.body, { headers });
        browser.__nativeEve.stats.starts++;
        let connection: Connection;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            connection = { controller, cursor: snapshot.tail + 1 };
            streams.add(connection);
            controller.enqueue(encoder.encode(withoutEnd(snapshot.body)));
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            const close = () => { if (streams.delete(connection)) { browser.__nativeEve.stats.aborts++; controller.close(); } };
            if (signal?.aborted) close(); else signal?.addEventListener("abort", close, { once: true });
          },
          cancel() { if (streams.delete(connection)) browser.__nativeEve.stats.aborts++; },
        });
        return new Response(body, { headers });
      };
    }, { sessionId: this.sessionId });
    await page.route(`**/api/${this.namespace}/thread-collections/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const threadId = url.searchParams.get("threadId");
      if (request.method() === "POST" && url.pathname.endsWith("/repair")) {
        const thread = this.collection.threads.find((item) => item.id === threadId);
        if (!thread) return route.fulfill({ status: 404, json: { ok: false } });
        if (!idle(conversationOf(this.events).view)) return route.fulfill({ status: 409, json: { ok: false } });
        const repaired = { ...thread, events: [...this.events], transcriptCoverage: {
          version: 1 as const, projection: "v27-source-lines" as const, startIndex: 0,
          endIndex: this.cursor, complete: true, authoritative: true,
        } };
        this.collection = { ...this.collection, threads: this.collection.threads.map((item) => item.id === threadId ? repaired : item) };
        this.revision++;
        return route.fulfill({ json: { thread: repaired, revision: this.revision }, headers: { etag: `"${this.revision}"` } });
      }
      if (request.method() === "GET") {
        const thread = this.collection.threads.find((item) => item.id === threadId);
        const result = url.searchParams.get("view") === "index" || !threadId
          ? { collection: summarizeThreadCollection(this.collection), revision: this.revision }
          : { thread: thread ?? null, revision: this.revision, eventWindow: { startIndex: 0, endIndex: thread?.events.length ?? 0,
            total: thread?.events.length ?? 0, hasMoreBefore: false } };
        return route.fulfill({ json: result, headers: { etag: `"${this.revision}"` } });
      }
      const expected = Number((request.headers()["if-match"] ?? "").replaceAll('"', ""));
      if (this.conflictsRemaining > 0 || expected !== this.revision) {
        if (this.conflictsRemaining > 0) { this.conflictsRemaining--; this.revision++; }
        return route.fulfill({ status: 409, json: { code: "thread_collection_conflict", ok: false }, headers: { etag: `"${this.revision}"` } });
      }
      if (request.method() === "PATCH") {
        const patch = parseThreadCollectionPatch(request.postDataJSON());
        if (!patch) return route.fulfill({ status: 400, json: { error: "Invalid v27 fixture checkpoint" } });
        this.collection = applyThreadCollectionPatch(this.collection, patch);
      } else if (request.method() === "PUT") this.collection = parseThreadCollection(request.postDataJSON().collection);
      this.revision++;
      return route.fulfill({ json: { ok: true, revision: this.revision }, headers: { etag: `"${this.revision}"` } });
    });
    await page.route(`**/api/${this.namespace}/sessions/${this.sessionId}`, async (route) => {
      if (route.request().method() === "POST") {
        const turnId = (route.request().postDataJSON() as { turnId?: string }).turnId;
        this.cancellations.push(turnId);
        await this.onCancel?.(turnId);
        return route.fulfill({ status: 202, json: { ok: true, sessionId: this.sessionId, status: "accepted" } });
      }
      const view = conversationOf(this.events).view;
      return route.fulfill({ json: { ok: true, state: idle(view) ? "waiting" : "running", tailIndex: this.cursor - 1,
        ...(activeTurn(view) ? { turnId: activeTurn(view)!.turnId } : {}) } });
    });
    await page.route("**/eve/v1/session", async (route) => {
      const deliveryId = `delivery-${++this.sendCount}`;
      const body = route.request().postDataJSON(); this.sends.push(body);
      await this.onSend?.(body);
      return route.fulfill({ status: 202, json: { sessionId: this.sessionId, deliveryId } });
    });
    await page.route(`**/eve/v1/session/${this.sessionId}`, async (route) => {
      const deliveryId = `delivery-${++this.sendCount}`;
      const body = route.request().postDataJSON(); this.sends.push(body);
      await this.onSend?.(body);
      return route.fulfill({ status: 202, json: { sessionId: this.sessionId, deliveryId } });
    });
    await page.route(`**/api/${this.namespace}/mailbox`, async (route) => {
      const body = route.request().postDataJSON();
      this.edits.push(body);
      await this.onEdit?.(body);
      return route.fulfill({ status: 202, json: { ok: true, item: { clientMessageId: body.clientMessageId, itemId: `mail-${this.edits.length}`, status: this.mailboxStatus } } });
    });
    await page.route(`**/api/${this.namespace}/mailbox/*`, (route) => route.fulfill({ json: { ok: true, item: {
      clientMessageId: this.edits.at(-1)?.clientMessageId, itemId: `mail-${this.edits.length}`, status: this.mailboxStatus,
    } } }));
  }
  seed(count = 1, id = "native-thread") {
    this.events = line(0, { type: "session.started", data: {} });
    for (let i = 0; i < count; i++) this.events.push(...startTurn(this.cursor, `history-${i}`, `history-delivery-${i}`, `History request ${i}`, i ? `history-${i-1}` : null),
      ...reply(this.cursor + 3, `history-${i}`, `history-delivery-${i}`, `History reply ${i}`));
    const now = Date.now();
    this.collection = parseThreadCollection({ version: 2, activeThreadId: id, threads: [{ id, createdAt: now, updatedAt: now,
      title: "Native history", events: this.events, closedInputRequestIds: [], queuedTurns: [], preferences: {
        executionMode: "standard", modelId: "gpt-5.6-sol", reasoning: "medium",
      }, session: { sessionId: this.sessionId, streamIndex: this.cursor }, status: "ready",
      transcriptCoverage: { version: 1, projection: "v27-source-lines", startIndex: 0, endIndex: this.cursor, complete: true, authoritative: true },
    }] });
  }
  async publish(events: SessionStreamEvent[], target: Page | Frame = this.page) {
    this.events.push(...events);
    await target.evaluate(({ body, tail }) => {
      (window as typeof window & { __nativeEve: { push(body: string, tail: number): void } }).__nativeEve.push(body, tail);
    }, { body: wireLines(events), tail: this.cursor - 1 });
  }
  async disconnect() {
    await this.page.evaluate(() => (window as typeof window & { __nativeEve: { disconnect(): void } }).__nativeEve.disconnect());
  }
  async send(text: string) {
    const composer = this.page.getByRole("textbox", { name: "Do anything" });
    await composer.fill(text); await composer.press("Enter");
    await expect(this.page.getByRole("log").getByText(text, { exact: true })).toHaveCount(1);
  }
  async edit(text: string) {
    const user = this.page.getByRole("log").locator('[data-message-id]').filter({ has: this.page.getByRole("button", { name: "Edit message", exact: true }) }).last();
    await user.hover();
    await user.getByRole("button", { name: "Edit message", exact: true }).click();
    const editor = this.page.locator("[data-agent-edit-composer]").getByRole("textbox");
    await editor.fill(text);
    await this.page.locator("[data-agent-edit-composer]").getByRole("button", { name: "Send", exact: true }).click();
  }
}
