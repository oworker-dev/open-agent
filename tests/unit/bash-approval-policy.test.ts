import assert from "node:assert/strict";
import test from "node:test";

import {
  bashApprovalDecision,
  bashCommandNeedsApproval,
  readBashApprovalMode,
} from "../../lib/bash-approval-policy.ts";

test("classifies destructive and external side-effecting shell commands", () => {
  for (const command of [
    "rm -rf /workspace/build",
    "git reset --hard HEAD^",
    "docker system prune -af",
    "kubectl delete deployment production",
    "npm publish",
    "curl -X POST https://example.com/jobs",
  ]) {
    assert.equal(bashCommandNeedsApproval(command), true, command);
  }
  for (const command of [
    "npm test",
    "git status --short",
    "sha256sum /workspace/result.txt",
    "rg TODO /workspace",
  ]) {
    assert.equal(bashCommandNeedsApproval(command), false, command);
  }
});

test("standard mode auto-approves sandbox-local changes but gates external side effects", () => {
  assert.equal(
    bashApprovalDecision({ command: "rm -f output.txt", mode: "risky" }),
    "not-applicable",
  );
  assert.equal(
    bashApprovalDecision({ actorType: "service", command: "rm -f output.txt", mode: "risky" }),
    "not-applicable",
  );
  assert.equal(
    bashApprovalDecision({ command: "curl -X POST https://example.com/jobs", mode: "risky" }),
    "user-approval",
  );
  assert.deepEqual(
    bashApprovalDecision({
      actorType: "service",
      command: "curl -X POST https://example.com/jobs",
      mode: "risky",
    }),
    {
      type: "denied",
      reason: "Unattended Agent sessions cannot approve a high-impact shell command.",
    },
  );
  assert.equal(
    bashApprovalDecision({ command: "npm test", mode: "risky" }),
    "not-applicable",
  );
  assert.equal(
    bashApprovalDecision({ command: "rm -f output.txt", mode: "never" }),
    "not-applicable",
  );
});

test("cautious execution mode gates otherwise safe shell commands", () => {
  assert.equal(
    bashApprovalDecision({ command: "npm test", executionMode: "cautious", mode: "risky" }),
    "user-approval",
  );
});

test("automation permits shell commands while the always policy remains an explicit override", () => {
  assert.equal(
    bashApprovalDecision({
      command: 'kill "$server_pid"',
      executionMode: "automation",
      mode: "risky",
    }),
    "not-applicable",
  );
  assert.equal(
    bashApprovalDecision({
      command: "curl -X POST https://example.com/jobs",
      executionMode: "automation",
      mode: "risky",
    }),
    "not-applicable",
  );
  assert.equal(
    bashApprovalDecision({
      command: "npm test",
      executionMode: "automation",
      mode: "always",
    }),
    "user-approval",
  );
});

test("parses only supported shell approval modes", () => {
  assert.equal(readBashApprovalMode({}), "risky");
  assert.equal(readBashApprovalMode({ AGENT_BASH_APPROVAL_MODE: "always" }), "always");
  assert.throws(
    () => readBashApprovalMode({ AGENT_BASH_APPROVAL_MODE: "sometimes" }),
    /must be always, risky, or never/,
  );
});
