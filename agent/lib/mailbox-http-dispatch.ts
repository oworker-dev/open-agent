import type { Channel, RouteHandlerArgs } from "eve/channels";
import type { AuthFn } from "eve/channels/auth";
import type { EveMessageContext, EveMessageResult } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";
import type { Answer } from "eve/events";
import { parseAssetPrompt, serializeAssetPrompt } from "@oworker/open-agent-contracts/asset";

type MailboxDispatch = {
  readonly auth: SessionAuthContext;
  readonly clientContext?: readonly string[];
  readonly history?: readonly { readonly id?: string; readonly role: "user" | "assistant"; readonly text: string }[];
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnPolicy: "queue" | "steer";
} & ({ readonly message: string; readonly answers?: never } | { readonly message?: never; readonly answers: readonly Answer[] });

/**
 * Compose the official HTTP handler in-process. The server Session.send surface
 * has no turn-scoped clientContext; translating it to `context` leaks it into
 * later turns. A private request capability admits only requests constructed
 * after the signed mailbox bridge has authenticated and authorized them.
 */
export function createMailboxHttpDispatcher() {
  const authorized = new WeakMap<Request, MailboxDispatch>();
  const auth: AuthFn<Request> = (request) => authorized.get(request)?.auth ?? null;
  const onMessage = (ctx: EveMessageContext): EveMessageResult => {
    const input = authorized.get(ctx.eve.request);
    return {
      auth: ctx.eve.caller,
      ...(input?.history ? { history: input.history } : {}),
    };
  };
  return {
    auth,
    onMessage,
    async dispatch(channel: Channel, args: RouteHandlerArgs, requestUrl: string, input: MailboxDispatch) {
      const route = channel.routes.find((route) => route.method === "POST" && route.path === "/eve/v1/session/:sessionId");
      if (!route || route.transport === "websocket") throw new Error("The Eve session message route is missing.");
      const request = new Request(new URL(`/eve/v1/session/${encodeURIComponent(input.sessionId)}`, requestUrl), {
        body: JSON.stringify({
          ...(input.answers ? { answers: input.answers } : {
            message: withClientMessageId(input.message!, input.idempotencyKey),
            turnPolicy: input.turnPolicy,
          }),
          ...(input.clientContext ? { clientContext: input.clientContext } : {}),
          idempotencyKey: input.idempotencyKey,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      authorized.set(request, input);
      try {
        return await route.handler(request, { ...args, params: { sessionId: input.sessionId } });
      } finally {
        authorized.delete(request);
      }
    },
  };
}

function withClientMessageId(message: string, clientMessageId: string): string {
  const parsed = parseAssetPrompt(message);
  return serializeAssetPrompt(parsed.text, parsed.assets, clientMessageId);
}
