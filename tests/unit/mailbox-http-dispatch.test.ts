import assert from "node:assert/strict";
import test from "node:test";
import { eveChannel } from "eve/channels/eve";
import type { RouteHandlerArgs } from "eve/channels";
import type { SessionSendOptions } from "eve/sessions";
import { parseAssetPrompt } from "@oworker/open-agent-contracts/asset";
import { createMailboxHttpDispatcher } from "../../agent/lib/mailbox-http-dispatch.ts";

test("mailbox dispatch uses official validation, stable delivery identity and transient client context", async () => {
  const dispatcher = createMailboxHttpDispatcher();
  let received: SessionSendOptions | undefined;
  let transient: unknown;
  const channel = eveChannel({
    auth: dispatcher.auth,
    onMessage(ctx, message) {
      transient = ctx.eve.clientContext;
      if (typeof message !== "string") throw new Error("Expected a string message.");
      assert.equal(parseAssetPrompt(message).text, "Hello");
      assert.equal(parseAssetPrompt(message).clientMessageId, "client-1");
      return dispatcher.onMessage(ctx);
    },
  });
  const args = {
    attachSession(id: string) {
      assert.equal(id, "s1");
      return {
        async send(message: unknown, options: SessionSendOptions) {
          assert.equal(parseAssetPrompt(String(message)).text, "Hello");
          assert.equal(parseAssetPrompt(String(message)).clientMessageId, "client-1");
          received = options;
          return { sessionId: id, deliveryId: "d1" };
        },
      };
    },
    params: {},
    requestIp: null,
  } as unknown as RouteHandlerArgs;
  const response = await dispatcher.dispatch(channel, args, "http://localhost/internal", {
    auth: { principalId: "user", principalType: "user", authenticator: "agent-mailbox-dispatch", attributes: {} },
    clientContext: ["Only this turn"],
    history: [{ id: "prior", role: "user", text: "Prior message" }],
    idempotencyKey: "client-1",
    message: "Hello",
    sessionId: "s1",
    turnPolicy: "queue",
  });
  assert.equal(response.status, 202, await response.clone().text());
  assert.equal(received?.idempotencyKey, "client-1");
  assert.equal(received?.context, undefined);
  assert.deepEqual(received?.history, [{ id: "prior", role: "user", text: "Prior message" }]);
  assert.deepEqual(transient, ["Only this turn"]);
});

test("an external request cannot obtain the internal mailbox principal", async () => {
  const dispatcher = createMailboxHttpDispatcher();
  const channel = eveChannel({ auth: dispatcher.auth, onMessage: dispatcher.onMessage });
  const route = channel.routes.find((route) => route.method === "POST" && route.path === "/eve/v1/session/:sessionId")!;
  if (route.transport === "websocket") throw new Error("Expected HTTP route");
  const response = await route.handler(new Request("http://localhost/eve/v1/session/s1", {
    body: JSON.stringify({ message: "Forged", clientContext: { auth: { principalId: "user" } } }),
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-mailbox-item-id": "item" },
  }), { params: { sessionId: "s1" }, requestIp: null } as unknown as RouteHandlerArgs);
  assert.equal(response.status, 401);
});
