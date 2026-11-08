import { Client, type ClientSession, type ClientSessionState, type HeadersValue } from "eve/client";
import type { AgentThreadPreferences, AgentWorkspaceClientConfig } from "./contracts.js";

export type AgentSessionConnection = {
  readonly auth?: AgentWorkspaceClientConfig["auth"];
  readonly client: Client;
  readonly headers: HeadersValue;
  readonly baseUrl: string;
  readonly initialSession?: ClientSessionState;
};

export function createAgentSession(
  config: AgentWorkspaceClientConfig | undefined,
  preferences: AgentThreadPreferences | (() => AgentThreadPreferences),
  state?: Partial<ClientSessionState>,
): AgentSessionConnection {
  const headers = async () => {
    const currentPreferences = typeof preferences === "function" ? preferences() : preferences;
    return {
      ...(await resolveHeaders(config?.headers)),
      "x-agent-execution-mode": currentPreferences.executionMode ?? "standard",
      "x-agent-model": currentPreferences.modelId,
      "x-agent-reasoning": currentPreferences.reasoning,
    };
  };
  const baseUrl = config?.host ?? "";
  const client = new Client({
    auth: config?.auth,
    baseUrl,
    headers,
    redirect: config?.redirect,
  });
  const initialSession = state?.sessionId
    ? { sessionId: state.sessionId, streamIndex: state.streamIndex ?? 0 }
    : undefined;
  return {
    ...(config?.auth ? { auth: config.auth } : {}),
    client,
    headers,
    baseUrl,
    ...(initialSession ? { initialSession } : {}),
  };
}

export function attachAgentSession(
  connection: AgentSessionConnection,
  state: ClientSessionState | undefined,
): ClientSession | undefined {
  return state
    ? connection.client.sessions.attach(state.sessionId, { streamIndex: state.streamIndex })
    : undefined;
}

async function resolveHeaders(headers: HeadersValue | undefined): Promise<Readonly<Record<string, string>>> {
  if (!headers) return {};
  return typeof headers === "function" ? await headers() : headers;
}
