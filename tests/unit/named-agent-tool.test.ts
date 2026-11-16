import assert from "node:assert/strict";
import test from "node:test";
import agent from "eve/tools/agent";
import namedAgent from "../../agent/tools/agent.ts";
import { z } from "zod";

test("named agent preserves official dispatch metadata and leaves the original tool unchanged", () => {
  assert.notEqual(namedAgent, agent);
  assert.equal(namedAgent.execute, agent.execute);
  for (const key of Reflect.ownKeys(agent)) {
    if (key === "description" || key === "inputSchema") continue;
    assert.deepEqual(Object.getOwnPropertyDescriptor(namedAgent, key), Object.getOwnPropertyDescriptor(agent, key));
  }
  const schema = namedAgent.inputSchema as z.ZodType;
  assert.deepEqual(schema.parse({ message: "Review the code", nickname: "  代码审查  " }), { message: "Review the code", nickname: "代码审查" });
  for (const nickname of ["", "a".repeat(81), "review\ncode"]) assert.equal(schema.safeParse({ message: "Review", nickname }).success, false);
});
