import type { MessageStreamEvent } from "eve/client";
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
  events: readonly MessageStreamEvent[],
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
  events: readonly MessageStreamEvent[],
): AgentRunProjection {
  return projectAgentRunFrom(current, events);
}

function projectAgentRunFrom(
  current: Pick<AgentRunRecord, "eventCount" | "failure" | "result" | "status" | "usage">,
  events: readonly MessageStreamEvent[],
): AgentRunProjection {
  let status: AgentRunStatus = current.status === "submitting" ? "running" : current.status;
  let result: AgentRunResult | undefined = current.result;
  let failure: AgentRunProjection["failure"] = current.failure;
  let cancelled = status === "cancelled";
  let waitingInput = status === "waiting-input";
  let waitingAuthorization = status === "waiting-authorization";
  const usage: MutableUsage = { ...current.usage };

  for (const event of events) {
    switch (event.type) {
      case "turn.started":
      case "message.received":
        waitingInput = false;
        waitingAuthorization = false;
        if (!cancelled && !failure) status = "running";
        break;
      case "input.requested":
        waitingInput = true;
        status = "waiting-input";
        break;
      case "authorization.required":
        waitingAuthorization = true;
        status = "waiting-authorization";
        break;
      case "authorization.completed":
        waitingAuthorization = false;
        status = "running";
        break;
      case "result.completed":
        result = { kind: "json", value: toJsonValue(event.data.result) };
        break;
      case "message.completed":
        if (event.data.message && event.data.finishReason !== "tool-calls") {
          result ??= { kind: "text", value: event.data.message };
        }
        break;
      case "step.completed":
        if (event.data.usage) {
          usage.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0;
          usage.cacheWriteTokens += event.data.usage.cacheWriteTokens ?? 0;
          usage.costUsd += event.data.usage.costUsd ?? 0;
          usage.inputTokens += event.data.usage.inputTokens ?? 0;
          usage.outputTokens += event.data.usage.outputTokens ?? 0;
        }
        usage.steps += 1;
        break;
      case "turn.cancelled":
        cancelled = true;
        status = "cancelled";
        break;
      case "turn.failed":
      case "session.failed":
        status = "failed";
        failure = {
          code: event.data.code,
          message: event.data.message,
          retryable: false,
        };
        break;
      case "session.completed":
        if (!cancelled && !failure) status = "completed";
        break;
      case "session.waiting":
        if (cancelled) status = "cancelled";
        else if (failure) status = "failed";
        else if (waitingInput) status = "waiting-input";
        else if (waitingAuthorization) status = "waiting-authorization";
        else status = "completed";
        break;
    }
  }

  return {
    eventCount: current.eventCount + events.length,
    ...(failure ? { failure } : {}),
    ...(result ? { result } : {}),
    status,
    usage,
  };
}

export function projectAgentEvents(
  runId: string,
  events: readonly MessageStreamEvent[],
  startIndex = 0,
): readonly AgentEvent[] {
  return events.map((event, index) => ({
    contractVersion: AGENT_RUN_CONTRACT_VERSION,
    ...(event.meta?.at ? { createdAt: event.meta.at } : {}),
    data: toJsonObject("data" in event ? event.data : {}),
    runId,
    sequence: startIndex + index + 1,
    type: eventType(event.type),
  }));
}

function eventType(type: MessageStreamEvent["type"]): AgentEventType {
  switch (type) {
    case "session.started": return "run.started";
    case "session.completed":
    case "turn.completed": return "run.completed";
    case "session.failed":
    case "turn.failed": return "run.failed";
    case "turn.cancelled": return "run.cancelled";
    case "message.received": return "message.received";
    case "message.appended": return "message.delta";
    case "message.completed": return "message.completed";
    case "reasoning.appended": return "reasoning.delta";
    case "reasoning.completed": return "reasoning.completed";
    case "action.input.partial": return "tool.input.delta";
    case "actions.requested": return "tool.requested";
    case "action.result": return "tool.completed";
    case "input.requested": return "input.requested";
    case "authorization.required": return "authorization.required";
    case "authorization.completed": return "authorization.completed";
    case "result.completed": return "result.completed";
    case "step.completed": return "usage.recorded";
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
