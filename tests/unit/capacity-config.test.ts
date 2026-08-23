import test from "node:test";
import assert from "node:assert/strict";

import {
  highestPassingLevel,
  parseCapacityLevels,
} from "../../lib/capacity-config.ts";

test("capacity levels are sorted, deduplicated, and bounded", () => {
  assert.deepEqual(parseCapacityLevels("500, 100,500, 250", [1]), [100, 250, 500]);
});

test("capacity levels reject input with no valid values", () => {
  assert.throws(() => parseCapacityLevels("0,-1,nope", [1]), /positive integers/u);
});

test("highest passing level ignores failed batches", () => {
  assert.equal(highestPassingLevel([
    { level: 100, ok: true, evidencePath: "a" },
    { level: 250, ok: false, evidencePath: "b" },
  ]), 100);
  assert.equal(highestPassingLevel([]), null);
});
