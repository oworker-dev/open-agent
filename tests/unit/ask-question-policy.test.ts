import assert from "node:assert/strict";
import test from "node:test";
import { mockModel } from "eve/evals";
import { jsonSchema, streamText, wrapLanguageModel } from "ai";
import type { ApprovalContext } from "eve/tools/approval";
import { askQuestionApproval, isAskQuestionEnabled, withoutAskQuestion } from "../../agent/lib/ask-question-policy.ts";

function context(tools?: readonly string[]) {
  return { session: { auth: { initiator: { attributes: {
    agentRunPolicy: JSON.stringify(tools === undefined ? {} : { tools }),
  } } } } };
}

test("questions default on, respect an empty allowlist, and inherit the initiating policy", () => {
  assert.equal(isAskQuestionEnabled(context()), true);
  assert.equal(isAskQuestionEnabled(context(["ask_question"])), true);
  assert.equal(isAskQuestionEnabled(context([])), false);
  assert.equal(isAskQuestionEnabled(context(["bash"])), false);
  assert.equal(isAskQuestionEnabled({ session: { auth: {
    ...context([]).session.auth,
    current: context(["ask_question"]).session.auth.initiator,
  } } }), false, "a later caller cannot expand the initiating policy");
});

test("disabled sessions omit the question schema from a real model request", async () => {
  let offered: readonly string[] | undefined;
  const baseModel = mockModel((request) => {
    offered = request.tools.map((tool) => tool.name);
    return "done";
  });
  assert.ok(typeof baseModel !== "string");
  const result = streamText({
    model: wrapLanguageModel({ model: baseModel, middleware: withoutAskQuestion }),
    prompt: "Continue without asking",
    tools: {
      ask_question: { inputSchema: jsonSchema({ type: "object" }) },
      bash: { inputSchema: jsonSchema({ type: "object" }) },
    },
  });
  await result.consumeStream();
  assert.equal(await result.text, "done");
  assert.deepEqual(offered, ["bash"], "other tool schemas must remain available");
});

test("the policy rejects a disabled question before the workflow starts", async () => {
  assert.deepEqual(await askQuestionApproval(context([]) as unknown as ApprovalContext), {
    type: "denied",
    reason: "ask_question is disabled by this session's tool policy.",
  });
  assert.equal(await askQuestionApproval(context() as unknown as ApprovalContext), "not-applicable");
});
