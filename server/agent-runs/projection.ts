import { eveEventCursor, eveEventsCursor } from "../../lib/eve-stream.ts";
import type { SessionStreamEvent } from "eve/client";
import {
  AGENT_RUN_CONTRACT_VERSION,
  type AgentEvent,
  type AgentEventType,
  type AgentRunResult,
  type AgentRunStatus,
  type AgentRunUsage,
  type JsonValue,
} from "@oworker/open-agent-contracts/agent-run";
import type {
  AgentRunProjection,
  AgentRunRecord,
} from "../data/agent-run-store.ts";

export function projectAgentRun(
  events: readonly SessionStreamEvent[],
): AgentRunProjection {
  return projectAgentRunFrom(
    {
      eventCount: 0,
      status: "running",
      usage: emptyUsage(),
    },
    events,
  );
}

export function projectAgentRunDelta(
  current: AgentRunRecord,
  events: readonly SessionStreamEvent[],
): AgentRunProjection {
  return projectAgentRunFrom(current, events);
}

function projectAgentRunFrom(
  current: Pick<AgentRunRecord, "eventCount" | "failure" | "result" | "status" | "usage">,
  events: readonly SessionStreamEvent[],
): AgentRunProjection {
  let status: AgentRunStatus = current.status === "submitting" ? "running" : current.status;
  let result: AgentRunResult | undefined = current.result;
  let failure: AgentRunProjection["failure"] = current.failure;
  const usage: MutableUsage = { ...current.usage };

  for (const event of events) {
    switch (event.type) {
      case "turn.started":
        result = undefined;
        failure = undefined;
        status = "running";
        break;
      case "model.requested":
      case "call.started":
        if (status === "waiting-input" || status === "waiting-authorization") status = "running";
        break;
      case "interaction.opened":
        status = event.data.request.kind === "sign-in" ? "waiting-authorization" : "waiting-input";
        break;
      case "interaction.settled":
        if (status === "waiting-input" || status === "waiting-authorization") status = "running";
        break;
      case "content.completed":
        if (event.data.phase !== "reply") break;
        if (event.data.kind === "result") result = { kind: "json", value: toJsonValue(event.data.value) };
        else if (event.data.kind === "text" && typeof event.data.value === "string" && result?.kind !== "json") {
          result = { kind: "text", value: (result?.kind === "text" ? result.value : "") + event.data.value };
        }
        break;
      case "usage.recorded":
        usage.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0;
        usage.cacheWriteTokens += event.data.usage.cacheWriteTokens ?? 0;
        usage.costUsd += event.data.usage.costUsd ?? 0;
        usage.inputTokens += event.data.usage.inputTokens ?? 0;
        usage.outputTokens += event.data.usage.outputTokens ?? 0;
        break;
      case "model.settled":
        if (event.scope?.turnId) usage.steps += 1;
        break;
      case "turn.settled":
        status = event.data.outcome === "cancelled" ? "cancelled"
          : event.data.outcome === "failed" ? "failed" : "completed";
        if (event.data.error) failure = { ...event.data.error, retryable: false };
        break;
      case "session.ended":
        if (event.data.outcome === "failed") {
          status = "failed";
          if (event.data.error) failure = { ...event.data.error, retryable: false };
        } else if (status !== "cancelled" && status !== "failed") status = "completed";
        break;
    }
  }

  return {
    eventCount: eveEventsCursor(events, current.eventCount),
    ...(failure ? { failure } : {}),
    ...(result ? { result } : {}),
    status,
    usage,
  };
}

export function projectAgentEvents(
  runId: string,
  events: readonly SessionStreamEvent[],
  startIndex = 0,
): readonly AgentEvent[] {
  return events.map((event, index) => ({
    contractVersion: AGENT_RUN_CONTRACT_VERSION,
    ...(event.meta?.at ? { createdAt: event.meta.at } : {}),
    data: toJsonObject("data" in event ? event.data : {}),
    runId,
    sequence: event.meta.position.line + 1,
    position: event.meta.position,
    cursor: eveEventCursor(event),
    type: eventType(event),
  }));
}

function eventType(event: SessionStreamEvent): AgentEventType {
  switch (event.type) {
    case "session.started": return "run.started";
    case "turn.settled":
      return event.data.outcome === "cancelled" ? "run.cancelled" : event.data.outcome === "failed" ? "run.failed" : "run.completed";
    case "session.ended": return event.data.outcome === "failed" ? "run.failed" : "runtime.event";
    case "delivery.consumed": return "message.received";
    case "content.delta": return event.data.kind === "reasoning" ? "reasoning.delta" : "message.delta";
    case "content.completed":
      return event.data.kind === "result" ? "result.completed" : event.data.kind === "reasoning" ? "reasoning.completed" : "message.completed";
    case "call.input": return "tool.input.delta";
    case "call.requested": return "tool.requested";
    case "call.settled": return "tool.completed";
    case "interaction.opened": return event.data.request.kind === "sign-in" ? "authorization.required" : "input.requested";
    case "interaction.settled": return "authorization.completed";
    case "usage.recorded": return "usage.recorded";
    default: return "runtime.event";
  }
}

function emptyUsage(): MutableUsage {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    steps: 0,
  };
}

type MutableUsage = { -readonly [Key in keyof AgentRunUsage]: AgentRunUsage[Key] };

function toJsonObject(value: unknown): Readonly<Record<string, JsonValue>> {
  const normalized = toJsonValue(value);
  return isJsonObject(normalized)
    ? normalized
    : { value: normalized };
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value ?? null);
  return JSON.parse(serialized) as JsonValue;
}
