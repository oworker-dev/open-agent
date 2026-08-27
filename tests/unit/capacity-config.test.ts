import test from "node:test";
import assert from "node:assert/strict";

import {
  highestPassingLevel,
  parseCapacityLevels,
  parseMixedCapacityLevels,
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

test("mixed capacity levels parse explicit stream and run pairs", () => {
  assert.deepEqual(parseMixedCapacityLevels("100:4, 250x8,100:4, 500/12", []), [
    { streams: 100, runs: 4 },
    { streams: 250, runs: 8 },
    { streams: 500, runs: 12 },
  ]);
  assert.throws(() => parseMixedCapacityLevels("broken,0:2", []), /stream:run/u);
  assert.throws(() => parseMixedCapacityLevels("100:101", []), /stream:run/u);
});
