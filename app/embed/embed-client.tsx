"use client";

import type { SessionStreamEvent } from "eve/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentWorkspace,
  createHttpAgentMailbox,
  createHttpAgentThreadStorage,
  type AgentThread,
  type AgentRuntimeStatus,
  type AgentWorkspaceClientConfig,
} from "@oworker/open-agent-ui";
import { createAgentUiConfig, AGENT_UI_MENTIONS } from "@/lib/agent-ui-config";
import { DEFAULT_AGENT_RUNTIME_CONFIG } from "@/lib/agent-runtime-config";
import {
  AGENT_EMBED_CONTRACT_VERSION,
  isAllowedAgentEmbedParentOrigin,
  parseAgentEmbedHostMessage,
  type AgentEmbedConfigureMessage,
  type AgentEmbedEvent,
} from "@oworker/open-agent-contracts/embed";

export function AgentEmbed({ allowedOrigins, runtimeStatus }: { readonly allowedOrigins: readonly string[]; readonly runtimeStatus: AgentRuntimeStatus }) {
  const [configuration, setConfiguration] = useState<AgentEmbedConfigureMessage>();
  const [fatalError, setFatalError] = useState<string>();
  const parentOriginRef = useRef<string | undefined>(undefined);

  const post = useCallback((event: AgentEmbedEvent) => {
    const parentOrigin = parentOriginRef.current;
    if (!parentOrigin || window.parent === window) return;
    window.parent.postMessage(event, parentOrigin);
  }, []);

  useEffect(() => {
    const parentOrigin = isAllowedAgentEmbedParentOrigin(document.referrer, allowedOrigins);
    if (!parentOrigin || window.parent === window) {
      setFatalError("This Agent embed was not opened by an allowed host.");
      return;
    }
    parentOriginRef.current = parentOrigin;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== parentOrigin || event.source !== window.parent) return;
      const message = parseAgentEmbedHostMessage(event.data);
      if (!message) {
        post({
          type: "agent.embed.error",
          contractVersion: AGENT_EMBED_CONTRACT_VERSION,
          code: "invalid-configuration",
          message: "The Agent embed configuration is invalid.",
        });
        return;
      }
      if (new URL(message.serviceUrl).origin !== window.location.origin) {
        post({
          type: "agent.embed.error",
          contractVersion: AGENT_EMBED_CONTRACT_VERSION,
          requestId: message.requestId,
          code: "service-origin-mismatch",
          message: "The Agent service URL must use the Embed origin.",
        });
        return;
      }
      if (Date.parse(message.expiresAt) <= Date.now()) {
        post({
          type: "agent.embed.error",
          contractVersion: AGENT_EMBED_CONTRACT_VERSION,
          requestId: message.requestId,
          code: "access-token-expired",
          message: "The Agent access token is expired.",
        });
        return;
      }
      applyTheme(message.theme ?? "system");
      if (message.locale) {
        window.localStorage.setItem(`${message.storageKey}:locale`, message.locale);
      }
      setConfiguration(message);
      setFatalError(undefined);
      post({
        type: "agent.embed.configured",
        contractVersion: AGENT_EMBED_CONTRACT_VERSION,
        requestId: message.requestId,
      });
    };
    window.addEventListener("message", receive);
    post({ type: "agent.embed.ready", contractVersion: AGENT_EMBED_CONTRACT_VERSION });
    return () => window.removeEventListener("message", receive);
  }, [allowedOrigins, post]);

  if (fatalError) {
    return <main className="flex h-dvh items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">{fatalError}</main>;
  }
  if (!configuration) {
    return <main className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">Connecting to host…</main>;
  }
  return <ConfiguredAgentEmbed
    configuration={configuration}
    key={JSON.stringify([configuration.serviceUrl, configuration.storageKey, configuration.profile.id, configuration.profile.version])}
    post={post}
    runtimeStatus={runtimeStatus}
  />;
}

function ConfiguredAgentEmbed({ configuration, post, runtimeStatus }: {
  readonly configuration: AgentEmbedConfigureMessage;
  readonly post: (event: AgentEmbedEvent) => void;
  readonly runtimeStatus: AgentRuntimeStatus;
}) {
  // This component is keyed by service/storage/profile scope. Renewals update
  // request data without replacing adapters or the live Eve store. An old
  // scope retains its own ref, so in-flight work cannot borrow a new scope's token.
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  const hostCallIdsRef = useRef(new Set<string>());
  const client = useMemo<AgentWorkspaceClientConfig>(() => ({
    headers: async () => ({
      authorization: `Bearer ${configurationRef.current.accessToken}`,
      "x-agent-profile-id": configurationRef.current.profile.id,
      "x-agent-profile-version": configurationRef.current.profile.version,
      ...(configurationRef.current.runPolicy
        ? { "x-agent-run-policy": encodeBase64Url(configurationRef.current.runPolicy) }
        : {}),
    }),
    host: configuration.serviceUrl,
    prepareSend: (input) => configurationRef.current.clientContext === undefined
      ? input
      : { ...input, clientContext: configurationRef.current.clientContext },
  }), [configuration.serviceUrl]);

  const threadStorage = useMemo(() => createHttpAgentThreadStorage({
    endpoint: `${configuration.serviceUrl.replace(/\/$/, "")}/api/agent/thread-collections`,
    getAccessToken: () => configurationRef.current.accessToken,
  }), [configuration.serviceUrl]);

  const mailbox = useMemo(() => createHttpAgentMailbox({
    endpoint: `${configuration.serviceUrl.replace(/\/$/, "")}/api/agent/mailbox`,
    getAccessToken: () => configurationRef.current.accessToken,
  }), [configuration.serviceUrl]);

  const onEvent = useCallback((event: SessionStreamEvent) => {
    if (event.type === "call.requested" && event.data.capability.name === "host_invoke") {
      hostCallIdsRef.current.add(event.data.callId);
    }
    const projected = projectEmbedEvent(event, hostCallIdsRef.current);
    if (event.type === "call.settled") hostCallIdsRef.current.delete(event.data.callId);
    if (projected) post(projected);
  }, [post]);

  const onDeleteThread = useCallback(async (thread: AgentThread) => {
    const sessionId = thread.session.sessionId;
    if (!sessionId) return;
    const response = await fetch(
      `${configuration.serviceUrl.replace(/\/$/, "")}/api/agent/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          authorization: `Bearer ${configurationRef.current.accessToken}`,
        },
        method: "DELETE",
        redirect: "error",
      },
    );
    if (response.ok) return;
    let message = `The Agent session could not be deleted (${response.status}).`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Preserve the status-based fallback when the service returns no JSON body.
    }
    throw new Error(message);
  }, [configuration.serviceUrl]);

  const ui = createAgentUiConfig(configuration.runtimeConfig ?? DEFAULT_AGENT_RUNTIME_CONFIG);
  return (
    <AgentWorkspace
      agentName="open-agent"
      client={client}
      commands={ui.commands}
      defaultPreferences={ui.defaultPreferences}
      extensions={ui.extensions}
      models={ui.models}
      mailbox={mailbox}
      mentions={AGENT_UI_MENTIONS}
      onEvent={onEvent}
      onDeleteThread={onDeleteThread}
      productName="Agent"
      reasoningLevels={ui.reasoningLevels}
      runtimeStatus={runtimeStatus}
      storageKey={configuration.storageKey}
      threadStorage={threadStorage}
    />
  );
}

function applyTheme(theme: "dark" | "light" | "system") {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

function encodeBase64Url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function projectEmbedEvent(event: SessionStreamEvent, hostCallIds: ReadonlySet<string>): AgentEmbedEvent | undefined {
  if (event.type === "turn.started") {
    return { type: "agent.embed.turn-started", contractVersion: AGENT_EMBED_CONTRACT_VERSION, turnId: event.data.turnId };
  }
  if (event.type === "turn.settled" && event.data.outcome === "completed") {
    return { type: "agent.embed.turn-completed", contractVersion: AGENT_EMBED_CONTRACT_VERSION, turnId: event.data.turnId };
  }
  if (event.type === "turn.settled" && event.data.outcome === "cancelled") {
    return { type: "agent.embed.turn-cancelled", contractVersion: AGENT_EMBED_CONTRACT_VERSION, turnId: event.data.turnId };
  }
  if (event.type === "turn.settled" && event.data.outcome === "failed") {
    return { type: "agent.embed.turn-failed", contractVersion: AGENT_EMBED_CONTRACT_VERSION, turnId: event.data.turnId, message: event.data.error?.message ?? "The agent turn failed." };
  }
  if (
    event.type === "call.settled" &&
    event.data.outcome === "completed" &&
    hostCallIds.has(event.data.callId) &&
    isRecord(event.data.output) &&
    typeof event.data.output.capability === "string" &&
    "output" in event.data.output
  ) {
    return {
      type: "agent.embed.host-capability-completed",
      contractVersion: AGENT_EMBED_CONTRACT_VERSION,
      capability: event.data.output.capability,
      output: event.data.output.output,
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
