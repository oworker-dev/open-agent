import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EveMessage, EveToolPart } from "eve/react";
import { conversationOf } from "eve/client";
import { AgentMessage, type AgentToolRendererProps, type AgentToolRenderers } from "@oworker/open-agent-ui";
import { line, startTurn } from "../helpers/session-events.ts";

const tool = (name: string, extra: Partial<EveToolPart> = {}): EveToolPart => ({
  type: "tool", kind: "tool", name, label: name, callId: "host-call", stepIndex: 0,
  state: "running", input: {}, ...extra,
} as EveToolPart);
const message = (part: EveToolPart): EveMessage => ({ id: "assistant", role: "assistant", parts: [part] });

function render(part: EveToolPart, toolRenderers?: AgentToolRenderers, extra: Partial<Parameters<typeof AgentMessage>[0]> = {}) {
  return renderToStaticMarkup(createElement(AgentMessage, {
    canRespond: true, events: [], isStreaming: true, locale: "en",
    message: message(part), onInputResponses: () => {}, toolRenderers, ...extra,
  }));
}

test("public tool renderers receive the projected part and can use React hooks", () => {
  const part = tool("host_invoke");
  let received: AgentToolRendererProps | undefined;
  const html = render(part, { host_invoke: props => {
    const [title] = useState("Host operation");
    received = props;
    return createElement("div", { "data-host-call": props.part.callId }, title);
  } });
  assert.match(html, /data-host-call="host-call"/);
  assert.match(html, /Host operation/);
  assert.equal(received?.part, part, "reuse the original projection instead of copying streaming state");
});

test("unregistered names and explicit fallback preserve the default tool UI", () => {
  const part = tool("bash", { input: { command: "printf fallback" } });
  const baseline = render(part);
  assert.equal(render(part, { ask_question: () => null }), baseline);
  assert.equal(render(part, { bash: ({ defaultContent }) => defaultContent }), baseline);
  // Inherited Object properties must never become accidental renderers.
  assert.equal(render(tool("constructor"), {}), render(tool("constructor")));
});

test("custom tool UI receives merged input deltas, progress replacement and durable replay", () => {
  const events = startTurn(0, "host", "delivery", "Run the host tool");
  const capture = (): AgentToolRendererProps => {
    const projected = conversationOf(events).messages.findLast(item => item.role === "assistant")!;
    let received: AgentToolRendererProps | undefined;
    render(tool("bash"), { bash: props => { received = props; return null; } }, { events, message: projected });
    assert.ok(received);
    return received;
  };
  events.push(...line(3, { type: "call.input", scope: { turnId: "host", runId: "host:run" }, data: {
    callId: "host-call", kind: "tool", name: "bash", delta: '{"command":"printf',
  } }));
  assert.equal(capture().part.inputText, '{"command":"printf');
  events.push(...line(4, { type: "call.input", scope: { turnId: "host", runId: "host:run" }, data: {
    callId: "host-call", delta: ' streamed"}',
  } }));
  assert.equal(capture().part.inputText, '{"command":"printf streamed"}');
  events.push(...line(5,
    { type: "call.requested", scope: { turnId: "host" }, data: { callId: "host-call", owner: { runId: "host:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "printf streamed" } } },
    { type: "call.started", scope: { turnId: "host" }, data: { callId: "host-call" } },
  ));
  for (const stdout of ["partial", "partial plus more"]) {
    events.push(...line(events.length, { type: "call.progress", scope: { turnId: "host" }, data: {
      callId: "host-call", output: { stdout },
    } }));
    assert.deepEqual(capture().part.output, { stdout });
  }
  events.push(...line(events.length, { type: "call.settled", scope: { turnId: "host" }, data: {
    callId: "host-call", outcome: "completed", output: { stdout: "final" },
  } }));
  const replay = capture();
  assert.equal(replay.part.callId, "host-call");
  assert.equal(replay.part.state, "completed");
  assert.deepEqual(replay.part.output, { stdout: "final" });
});

test("custom question UI retains the response and close callbacks, including closed/read-only state", async () => {
  const question = tool("ask_question", { interaction: {
    interactionId: "question", status: "open", turnId: "turn", stepIndex: 0,
    request: { kind: "question", prompt: "Choose", allowFreeform: true },
  } });
  const answers: unknown[] = [];
  const closed: string[] = [];
  let received: AgentToolRendererProps | undefined;
  render(question, { ask_question: props => { received = props; return null; } }, {
    canRespond: false, closedInputRequestIds: new Set(["question"]),
    onInputResponses: async responses => { answers.push(...responses); },
    onCloseInputRequest: id => { closed.push(id); },
  });
  assert.ok(received);
  assert.equal(received.canRespond, false);
  assert.equal(received.inputRequestClosed, true);
  await received.onInputResponses([{ interactionId: "question", text: "Custom host answer" }]);
  received.onCloseInputRequest("question");
  assert.deepEqual(answers, [{ interactionId: "question", text: "Custom host answer" }]);
  assert.deepEqual(closed, ["question"]);
});

test("custom subagent UI retains the host's navigation and asset resolvers", () => {
  let received: AgentToolRendererProps | undefined;
  const opened: string[] = [];
  render(tool("agent", { kind: "agent" }), { agent: props => { received = props; return null; } }, {
    onOpenSubagent: id => opened.push(id), assetUrl: id => `/host/assets/${id}`,
  });
  assert.ok(received);
  received.onOpenSubagent?.("child-session");
  assert.equal(received.assetUrl?.("asset"), "/host/assets/asset");
  assert.deepEqual(opened, ["child-session"]);
});
