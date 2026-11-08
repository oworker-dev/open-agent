import assert from "node:assert/strict";
import test from "node:test";

import { line, startTurn } from "../helpers/session-events.ts";
import {
  approximateTokenCount,
  interruptedTurnContextFromEvents,
  recoveryContextTokenBudget,
  sanitizeRetainedContext,
  truncateMiddleToTokenBudget,
} from "../../packages/agent-ui/src/agent-workspace/retained-context.ts";

test("scales Codex recovery context to the selected model window", () => {
  assert.equal(recoveryContextTokenBudget(272_000), 20_000);
  assert.equal(recoveryContextTokenBudget(136_000), 10_000);
  assert.equal(recoveryContextTokenBudget(544_000), 20_000);
});

test("token truncation preserves the beginning and end of a large observation", () => {
  const truncated = truncateMiddleToTokenBudget(
    `COMMAND_START\n${"middle-output\n".repeat(2_000)}FINAL_ERROR_TAIL`,
    1_000,
  );

  assert.match(truncated, /^COMMAND_START/);
  assert.match(truncated, /approximate tokens omitted/);
  assert.match(truncated, /FINAL_ERROR_TAIL$/);
  assert.ok(approximateTokenCount(truncated) <= 1_000);
});

test("an interrupted bash checkpoint keeps exact intent, command, exit status, and output tail", () => {
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn-0", "delivery", "Build and verify the company website"),
    ...line(4, { type: "call.requested", scope: { turnId: "turn-0" }, data: { callId: "call-bash", owner: { runId: "turn-0:run" }, capability: { kind: "tool", name: "bash" }, input: { command: "npm run build" } } }),
    ...line(5, { type: "call.settled", scope: { turnId: "turn-0" }, data: { callId: "call-bash", outcome: "completed", output: {
      exitCode: 1, stderr: `provider log\n${"noise\n".repeat(10_000)}FINAL_ERROR_TAIL`,
      stdout: `BUILD_START\n${"asset\n".repeat(10_000)}BUILD_OUTPUT_TAIL`, truncated: true,
    } } })];

  const context = interruptedTurnContextFromEvents(
    events,
    "turn-0",
    undefined,
    272_000,
  )?.join("\n") ?? "";

  assert.match(context, /Original user request: Build and verify the company website/);
  assert.match(context, /command: npm run build/);
  assert.match(context, /exit code: 1/);
  assert.match(context, /FINAL_ERROR_TAIL/);
  assert.ok(approximateTokenCount(context) <= 20_000);
});

test("a write checkpoint keeps the file reference instead of duplicating its payload", () => {
  const content = `SENSITIVE_FILE_BODY\n${"body\n".repeat(20_000)}`;
  const events = [...line(0, { type: "session.started", data: {} }), ...startTurn(1, "turn-write", "delivery", "Write the file"),
    ...line(4, { type: "call.requested", scope: { turnId: "turn-write" }, data: { callId: "call-write", owner: { runId: "turn-write:run" }, capability: { kind: "tool", name: "write_file" }, input: { content, filePath: "/workspace/site/index.html" } } }),
    ...line(5, { type: "call.settled", scope: { turnId: "turn-write" }, data: { callId: "call-write", outcome: "completed", output: { path: "/workspace/site/index.html", written: true } } })];

  const context = interruptedTurnContextFromEvents(
    events,
    "turn-write",
    undefined,
    272_000,
  )?.join("\n") ?? "";

  assert.match(context, /path: \/workspace\/site\/index\.html/);
  assert.match(context, /re-read the file/);
  assert.doesNotMatch(context, /SENSITIVE_FILE_BODY/);
});

test("storage hydration uses the shared token budget rather than a 32k character slice", () => {
  const entry = `HEAD-${"x".repeat(39_990)}-TAIL`;
  const [hydrated = ""] = sanitizeRetainedContext([entry], 272_000) ?? [];

  assert.equal(hydrated, entry);
  assert.match(hydrated, /-TAIL$/);
});
