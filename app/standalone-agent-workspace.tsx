"use client";

import { useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import {
  AgentWorkspace,
  browserThreadStorage,
  createHttpAgentMailbox,
  createHttpAgentThreadStorage,
  type AgentExtensionInfo,
  type AgentModelOption,
  type AgentPromptMenuItem,
  type AgentRuntimeStatus,
  type AgentSessionBoundary,
  type AgentSubagentSummary,
  type AgentThreadPreferences,
} from "@oworker/open-agent-ui";

type StandaloneAgentWorkspaceProps = {
  readonly commands: readonly AgentPromptMenuItem[];
  readonly defaultPreferences: AgentThreadPreferences;
  readonly extensions: readonly AgentExtensionInfo[];
  readonly initialSubagentSessionId?: string;
  readonly initialThreadId?: string;
  readonly mentions: readonly AgentPromptMenuItem[];
  readonly models: readonly AgentModelOption[];
  readonly reasoningLevels: readonly string[];
  readonly runtimeStatus: AgentRuntimeStatus;
  readonly storageMode: "browser" | "server";
};

export function StandaloneAgentWorkspace({
  commands,
  defaultPreferences,
  extensions,
  initialSubagentSessionId,
  initialThreadId,
  mentions,
  models,
  reasoningLevels,
  runtimeStatus,
  storageMode,
}: StandaloneAgentWorkspaceProps) {
  const pathname = usePathname();
  const httpThreadStorage = useMemo(
    () => createHttpAgentThreadStorage({
      endpoint: "/api/standalone/thread-collections",
      ...(initialThreadId ? { initialThreadId } : {}),
    }),
    [initialThreadId],
  );
  const mailbox = useMemo(
    () => storageMode === "server"
      ? createHttpAgentMailbox({ endpoint: "/api/standalone/mailbox" })
      : undefined,
    [storageMode],
  );
  const threadStorage = storageMode === "server" ? httpThreadStorage : browserThreadStorage;
  const loadSubagents = useCallback(async (sessionId: string): Promise<readonly AgentSubagentSummary[]> => {
    if (storageMode !== "server") return [];
    const response = await fetch(`/api/standalone/sessions/${encodeURIComponent(sessionId)}/subagents`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Subagent status request failed (${response.status}).`);
    const body = await response.json() as { children?: unknown };
    return Array.isArray(body.children) ? body.children.filter(isSubagentSummary) : [];
  }, [storageMode]);
  const inspectSession = useCallback(async (sessionId: string): Promise<AgentSessionBoundary> => {
    if (storageMode !== "server") return { state: "running" };
    const response = await fetch(`/api/standalone/sessions/${encodeURIComponent(sessionId)}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Session boundary request failed (${response.status}).`);
    const body = await response.json() as Partial<AgentSessionBoundary>;
    if (body.state !== "running" && body.state !== "waiting" && body.state !== "terminal") {
      throw new Error("The Agent runtime returned an invalid session boundary.");
    }
    return {
      state: body.state,
      ...(typeof body.lastEventAt === "string" ? { lastEventAt: body.lastEventAt } : {}),
      ...(typeof body.tailIndex === "number" && Number.isSafeInteger(body.tailIndex) && body.tailIndex >= 0 ? { tailIndex: body.tailIndex } : {}),
      ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
      ...(body.terminalStatus === "completed" || body.terminalStatus === "failed" ? { terminalStatus: body.terminalStatus } : {}),
    };
  }, [storageMode]);
  const controlSubagent = useCallback(async (input: { readonly action: "close" | "interrupt" | "wait"; readonly sessionId: string }): Promise<AgentSubagentSummary | undefined> => {
    if (storageMode !== "server") return undefined;
    const response = await fetch(`/api/standalone/subagents/${encodeURIComponent(input.sessionId)}`, {
      body: JSON.stringify({ action: input.action }),
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      method: "POST",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Subagent control request failed (${response.status}).`);
    const body = await response.json() as { subagent?: unknown };
    return isSubagentSummary(body.subagent) ? body.subagent : undefined;
  }, [storageMode]);
  const handleActiveThreadChange = useCallback((threadId?: string) => {
    const target = threadId ? `/threads/${encodeURIComponent(threadId)}` : "/";
    if (window.location.pathname !== target) window.history.replaceState(null, "", target);
  }, [pathname]);
  const handleActiveSubagentChange = useCallback((threadId: string, sessionId?: string) => {
    const target = sessionId
      ? `/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(sessionId)}`
      : `/threads/${encodeURIComponent(threadId)}`;
    if (window.location.pathname !== target) window.history.replaceState(null, "", target);
  }, []);

  return (
    <AgentWorkspace
      agentName="open-agent"
      commands={commands}
      controlSubagent={controlSubagent}
      defaultPreferences={defaultPreferences}
      extensions={extensions}
      initialSubagentSessionId={initialSubagentSessionId}
      initialThreadId={initialThreadId}
      inspectSession={inspectSession}
      mentions={mentions}
      models={models}
      mailbox={mailbox}
      loadSubagents={loadSubagents}
      onActiveSubagentChange={handleActiveSubagentChange}
      onActiveThreadChange={handleActiveThreadChange}
      productName="Open Agent"
      reasoningLevels={reasoningLevels}
      runtimeStatus={runtimeStatus}
      threadStorage={threadStorage}
    />
  );
}

function isSubagentSummary(value: unknown): value is AgentSubagentSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.childSessionId === "string" && ["starting", "running", "waiting", "completed", "failed", "interrupted", "closed"].includes(String(item.status));
}
