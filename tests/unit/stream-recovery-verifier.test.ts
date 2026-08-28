import assert from "node:assert/strict";
import test from "node:test";

import {
  compareRecoveredEventSequence,
} from "../../scripts/lib/stream-recovery-verification.mjs";

test("accepts an exact recovered sequence by stable event id", () => {
  const canonical = [event("evt_1"), event("evt_2"), event("evt_3")];
  const result = compareRecoveredEventSequence([...canonical], canonical);

  assert.equal(result.stableIdSequenceMatch, true);
  assert.equal(result.firstMismatchIndex, undefined);
  assert.deepEqual(result.violations, []);
});

test("rejects a missing event even when later ids still match", () => {
  const result = compareRecoveredEventSequence(
    [event("evt_1"), event("evt_3")],
    [event("evt_1"), event("evt_2"), event("evt_3")],
  );

  assert.equal(result.stableIdSequenceMatch, false);
  assert.equal(result.firstMismatchIndex, 1);
  assert.match(result.violations.join(" "), /diverged/u);
});

test("rejects duplicate ids introduced by reconnect overlap", () => {
  const result = compareRecoveredEventSequence(
    [event("evt_1"), event("evt_2"), event("evt_2")],
    [event("evt_1"), event("evt_2")],
  );

  assert.equal(result.stableIdSequenceMatch, false);
  assert.match(result.violations.join(" "), /duplicate stable event ids appeared after reconnect/u);
});

test("rejects events without a stable id", () => {
  const result = compareRecoveredEventSequence(
    [{ meta: {}, type: "step.started" }],
    [{ meta: {}, type: "step.started" }],
  );

  assert.equal(result.stableIdSequenceMatch, false);
  assert.match(result.violations.join(" "), /did not contain a stable event id/u);
});

function event(id: string) {
  return { meta: { id }, type: "step.started" };
}
