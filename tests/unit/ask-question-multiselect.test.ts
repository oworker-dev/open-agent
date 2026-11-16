import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EveMessage, EveToolPart } from "eve/react";
import { encodeMultiSelectAnswer, parseMultiSelectAnswer } from "@oworker/open-agent-contracts";
import type { ToolAnswer, ToolQuestion, WorkflowToolContext } from "eve/tools";
import { AgentMessage } from "@oworker/open-agent-ui";
import { executeAskQuestion } from "../../agent/tools/ask_question.ts";

const options = [
  { label: "Markdown", description: "Readable plain text." },
  { label: "JSON", description: "Structured data." },
  { label: "CSV", description: "Tabular rows." },
];

test("multi-select answer codec preserves distinct option ids and additional text", () => {
  const encoded = encodeMultiSelectAnswer({
    additionalText: "  Keep the output concise.  ",
    optionIds: ["Markdown", "JSON", "Markdown"],
  });
  assert.deepEqual(parseMultiSelectAnswer(encoded), {
    additionalText: "Keep the output concise.",
    optionIds: ["Markdown", "JSON"],
  });
  assert.equal(parseMultiSelectAnswer("open-agent:ask-question-multi:v1:not-json"), undefined);
  assert.equal(parseMultiSelectAnswer('open-agent:ask-question-multi:v1:{"optionIds":["A","A"],"additionalText":""}'), undefined);
});

test("multi-select ask_question renders checkbox controls", () => {
  const part = {
    type: "tool",
    kind: "tool",
    name: "ask_question",
    label: "Question",
    callId: "ask-multi",
    stepIndex: 0,
    state: "running",
    input: { question: "Which formats?", multiple: true },
    interaction: {
      interactionId: "ask-multi-input",
      status: "open",
      turnId: "turn",
      stepIndex: 0,
      request: {
        kind: "question",
        prompt: "Which formats?",
        display: "select",
        allowFreeform: true,
        options: options.map(({ label }) => ({ id: label, label })),
      },
    },
  } as unknown as EveToolPart;
  const message = { id: "assistant", role: "assistant", parts: [part] } as unknown as EveMessage;
  const html = renderToStaticMarkup(createElement(AgentMessage, {
    canRespond: true,
    events: [],
    isStreaming: true,
    locale: "en",
    message,
    onInputResponses: () => undefined,
  }));

  assert.match(html, /type="checkbox"/);
  assert.match(html, /Choose all that apply\./);
  assert.match(html, /aria-label="Additional information"/);

});

test("ask_question returns selected labels and optional context to the model", async () => {
  let request: ToolQuestion | undefined;
  const context = {
    ask: async (value: ToolQuestion): Promise<ToolAnswer> => {
      request = value;
      return {
        status: "answered",
        text: encodeMultiSelectAnswer({
          additionalText: "Keep the output concise.",
          optionIds: ["Markdown", "CSV"],
        }),
      };
    },
  } as unknown as WorkflowToolContext;

  const output = await executeAskQuestion({ question: "Which formats?", options, multiple: true }, context);

  assert.deepEqual(request, {
    allowFreeform: true,
    display: "select",
    options: options.map(({ label, description }) => ({ id: label, label, description })),
    prompt: "Which formats?",
  });
  assert.deepEqual(output, {
    answer: "Selected options:\n- Markdown\n- CSV\n\nAdditional information:\nKeep the output concise.",
    status: "answered",
  });
});

test("single choice and free text keep the existing answer shape", async () => {
  const optionContext = { ask: async () => ({ status: "answered", optionId: "Markdown" }) } as unknown as WorkflowToolContext;
  const textContext = { ask: async () => ({ status: "answered", text: "Use plain text" }) } as unknown as WorkflowToolContext;
  const singleInput = { question: "Which format?", options, multiple: false };

  assert.deepEqual(await executeAskQuestion(singleInput, optionContext), { answer: "Markdown", status: "answered" });
  assert.deepEqual(await executeAskQuestion({ question: "What should I know?", multiple: false }, textContext), {
    answer: "Use plain text",
    status: "answered",
  });
});

test("ask_question preserves cancellation and unavailable outcomes", async () => {
  const cancelled = { ask: async () => ({ status: "cancelled" }) } as unknown as WorkflowToolContext;
  const unavailable = { ask: async () => ({ status: "unavailable" }) } as unknown as WorkflowToolContext;

  assert.deepEqual(await executeAskQuestion({ question: "Choose", options, multiple: true }, cancelled), { interrupted: true });
  assert.deepEqual(await executeAskQuestion({ question: "Choose", options, multiple: true }, unavailable), { status: "unavailable" });
});
