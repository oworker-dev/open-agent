"use client";

import {
  createEveAgentSessionClient,
  type AgentSession,
} from "@oworker/open-agent-client/eve-session";
import type {
  AgentSessionCursor,
  AgentSessionEvent,
  AgentSessionInputRequest,
} from "@oworker/open-agent-contracts/agent-session";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { activeTurn, idle, openInteractions } from "eve/events";

export type CustomAgentPanelProps = {
  readonly baseUrl: string;
  /** Called before every HTTP request and stream reconnect, so tokens may rotate. */
  readonly getAccessToken: () => string | Promise<string>;
  readonly storageKey?: string;
  readonly title?: string;
};

type PersistedSession = {
  readonly cursor?: AgentSessionCursor;
  readonly events: readonly AgentSessionEvent[];
  readonly respondedRequestIds?: readonly string[];
};

const EMPTY_SESSION: PersistedSession = { events: [] };

export function CustomAgentPanel({
  baseUrl,
  getAccessToken,
  storageKey = "open-agent:custom-host:v1",
  title = "Agent",
}: CustomAgentPanelProps) {
  const restored = useMemo(() => loadSession(storageKey), [storageKey]);
  const client = useMemo(
    () => createEveAgentSessionClient({ baseUrl, getAccessToken }),
    [baseUrl, getAccessToken],
  );
  const session = useMemo(() => client.session(restored.cursor), [client, restored.cursor]);
  const [events, setEvents] = useState<readonly AgentSessionEvent[]>(restored.events);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [respondedRequestIds, setRespondedRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(restored.respondedRequestIds),
  );
  const resumeStarted = useRef(false);

  const appendEvent = useCallback((event: AgentSessionEvent) => {
    setEvents((current) => {
      if (current.some((item) => item.position.line === event.position.line && item.position.index === event.position.index)) return current;
      return [...current, event].sort((a, b) => a.position.line - b.position.line || a.position.index - b.position.index);
    });
  }, []);

  const consume = useCallback(async (stream: AsyncIterable<AgentSessionEvent>) => {
    setIsBusy(true);
    setError(undefined);
    try {
      for await (const event of stream) appendEvent(event);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Agent stream failed.");
    } finally {
      setIsBusy(false);
    }
  }, [appendEvent]);

  useEffect(() => {
    saveSession(storageKey, {
      cursor: session.cursor,
      events,
      respondedRequestIds: [...respondedRequestIds],
    });
  }, [events, respondedRequestIds, session, storageKey]);

  useEffect(() => {
    if (resumeStarted.current || !needsResume(restored)) return;
    resumeStarted.current = true;
    void consume(session.stream());
  }, [consume, restored, session]);

  const send = async (message: string) => {
    if (!message.trim() || isBusy) return;
    setInput("");
    setIsBusy(true);
    try {
      const turn = await session.send(message.trim());
      await consume(turn);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Agent request failed.");
      setIsBusy(false);
    }
  };

  const approve = async (request: AgentSessionInputRequest, optionId: string) => {
    if (isBusy) return;
    setRespondedRequestIds((current) => new Set(current).add(request.interactionId));
    setIsBusy(true);
    try {
      const turn = await session.send({
        inputResponses: [{ optionId, interactionId: request.interactionId }],
      });
      await consume(turn);
    } catch (cause) {
      setRespondedRequestIds((current) => withoutValue(current, request.interactionId));
      setError(cause instanceof Error ? cause.message : "The approval response failed.");
      setIsBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await session.cancel({ turnId: latestTurnId(events) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Agent turn could not be cancelled.");
    }
  };

  const pendingRequests = latestInputRequests(events).filter(
    (request) => !respondedRequestIds.has(request.interactionId),
  );
  return (
    <section className="custom-agent" aria-label={title}>
      <header className="custom-agent__header">
        <strong>{title}</strong>
        <span>{isBusy ? "Running" : "Ready"}</span>
      </header>

      <div className="custom-agent__events" aria-live="polite">
        {events.length === 0 ? <p>Start a task with the independent Agent service.</p> : null}
        {events.map((event) => (
          <article className="custom-agent__event" key={`${event.position.line}:${event.position.index}`}>
            <small>{event.type}</small>
            <p>{eventText(event)}</p>
          </article>
        ))}
      </div>

      {pendingRequests.map((request) => (
        <aside className="custom-agent__approval" key={request.interactionId}>
          <p>{request.request.prompt}</p>
          <div>
            {request.request.options?.map((option) => (
              <button disabled={isBusy} key={option.id} onClick={() => void approve(request, option.id)} type="button">
                {option.label}
              </button>
            ))}
          </div>
        </aside>
      ))}

      {error ? <p className="custom-agent__error" role="alert">{error}</p> : null}

      <form
        className="custom-agent__composer"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <textarea disabled={isBusy} onChange={(event) => setInput(event.target.value)} value={input} />
        {isBusy ? (
          <button onClick={() => void cancel()} type="button">Stop</button>
        ) : (
          <button disabled={!input.trim()} type="submit">Send</button>
        )}
      </form>
    </section>
  );
}

function needsResume(session: PersistedSession): boolean {
  if (!session.cursor?.sessionId || session.events.length === 0) return false;
  return !idle(sessionView(session.events));
}

function latestTurnId(events: readonly AgentSessionEvent[]): string | undefined {
  return activeTurn(sessionView(events))?.turnId;
}

function latestInputRequests(events: readonly AgentSessionEvent[]): readonly AgentSessionInputRequest[] {
  return openInteractions(sessionView(events));
}

function sessionView(events: readonly AgentSessionEvent[]) {
  // The Eve session adapter preserves the native data, scope and reader meta.
  return conversationOf(events as unknown as readonly SessionStreamEvent[]).view;
}

function eventText(event: AgentSessionEvent): string {
  const data = asRecord(event.data);
  if (typeof data?.delta === "string") return data.delta;
  if (typeof data?.value === "string") return data.value;
  const capability = asRecord(data?.capability);
  if (typeof capability?.name === "string") return capability.name;
  return event.type.replaceAll(".", " ");
}

function loadSession(storageKey: string): PersistedSession {
  if (typeof window === "undefined") return EMPTY_SESSION;
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as PersistedSession | null;
    return value && Array.isArray(value.events) ? value : EMPTY_SESSION;
  } catch {
    return EMPTY_SESSION;
  }
}

function saveSession(storageKey: string, session: PersistedSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey, JSON.stringify(session));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function withoutValue(source: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (!source.has(value)) return source;
  const next = new Set(source);
  next.delete(value);
  return next;
}
