import assert from "node:assert/strict";
import test from "node:test";
import { COMPILED_AGENT_TOOL_NAMES } from "../../lib/agent-extension-catalog.ts";

// Exercise the installed runtime, including the patch. Config-only assertions
// missed the filtering regression during the 0.56 upgrade.
const source = new URL(".", import.meta.resolve("eve"));
const internal = (path: string) => import(new URL(path, source).href);
const { ContextContainer, contextStorage } = await internal("context/container.js");
const { AuthKey, InitiatorAuthKey, OfferedCatalogToolsKey } = await internal("context/keys.js");
const { ConnectionRegistryKey } = await internal("context/providers/connection-key.js");
const { defineJsonSchema } = await internal("tools/schema.js");
const { buildStepCatalog } = await internal("execution/catalog/step-catalog.js");
const { buildToolSetWithProviderTools } = await internal("harness/tools.js");
const { runApprovedCalls } = await internal("harness/hitl/approved-calls.js");
const { invokeTool } = await internal("execution/invoke-tool.js");
const { buildSubagentRunInput } = await internal("subagents/tool.js");

function principal(tools?: readonly string[]) {
  return { principalType: "user", principalId: "policy-test", attributes: {
    agentRunPolicy: JSON.stringify(tools === undefined ? {} : { tools }),
  } };
}
function context(tools?: readonly string[]) {
  const ctx = new ContextContainer();
  ctx.set(InitiatorAuthKey, principal(tools));
  ctx.set(AuthKey, principal(tools));
  return ctx;
}
function definition(name: string, extra: Record<string, unknown> = {}) {
  return { name, description: name, inputSchema: defineJsonSchema({ type: "object", properties: {} }),
    execute: () => ({ ok: true }), ...extra };
}
const agentTools = new Map([...COMPILED_AGENT_TOOL_NAMES].map(name => [name, definition(name)]));
function catalog(ctx = context(), tools = agentTools, rootSessionId?: string) {
  return contextStorage.run(ctx, () => buildStepCatalog({
    agentTools: tools, ctx, endsTurn: true, session: { rootSessionId },
  }));
}

test("every compiled tool can be enabled or disabled by the same session grant", () => {
  assert.deepEqual([...catalog().entries.keys()], [...COMPILED_AGENT_TOOL_NAMES]);
  assert.equal(catalog(context([])).entries.size, 0);
  for (const name of COMPILED_AGENT_TOOL_NAMES) {
    const selected = catalog(context([name]));
    assert.deepEqual([...selected.entries.keys()], [name]);
    const excluded = catalog(context([...COMPILED_AGENT_TOOL_NAMES].filter(other => other !== name)));
    assert.equal(excluded.get(name), undefined);
    assert.equal(excluded.resolve({ toolName: name, input: {}, toolCallId: "forced" }), undefined);
  }
});

test("provider-native web search is omitted before provider tool injection", async () => {
  const tools = new Map([["web_search", definition("web_search", {
    execute: undefined, behavior: { availability: [], handling: { kind: "provider-tool", provider: "native" } },
  })]]);
  for (const enabled of [false, true]) {
    const selected = catalog(context(enabled ? ["web_search"] : []), tools);
    const offered = await buildToolSetWithProviderTools({
      tools: selected.advertised, describe: selected.describe,
      profile: { provider: "openai", gateway: false },
    });
    assert.deepEqual(Object.keys(offered), enabled ? ["web_search"] : []);
    if (enabled) assert.equal(offered.web_search.type, "provider");
  }
});

test("catalog search and indirect calls cannot discover or bypass disabled tools", async () => {
  const ctx = context(["read_file"]);
  // Catalog controls may have been offered before a restart/resume.
  ctx.set(OfferedCatalogToolsKey, { tools: true });
  const tools = new Map([
    ["read_file", definition("read_file", { deferred: true })],
    ["bash", definition("bash", { deferred: true })],
  ]);
  const selected = catalog(ctx, tools);
  const search = await selected.get("eve__search").execute({ query: "bash" });
  assert.equal(search.results.some((item: { tool: string }) => item.tool === "bash"), false);
  assert.equal(selected.resolve({ toolName: "eve__tool", input: { name: "bash", input: {} } }), undefined);
  assert.equal(selected.resolve({ toolName: "eve__tool", input: { name: "read_file", input: {} } })?.definition.name, "read_file");
});

test("workflow and delegation entries obey the grant while task controls remain available", () => {
  const tools = new Map([
    ["ask_question", definition("ask_question", { execute: undefined, workflowId: "question" })],
    ["agent", definition("agent", { execute: undefined, workflowId: "child",
      behavior: { availability: [], handling: { kind: "dispatch", target: { kind: "subagent" } } } })],
  ]);
  const empty = catalog(context([]), tools);
  assert.equal(empty.offersTasks, false);
  assert.equal(empty.get("ask_question"), undefined);
  assert.equal(empty.get("agent"), undefined);
  const delegated = catalog(context(["agent"]), tools);
  assert.equal(delegated.offersTasks, true);
  assert.ok(delegated.get("eve__task_cancel"));
  assert.ok(delegated.get("eve__task_wait"));
});

test("child sessions and fresh-process reconstruction cannot expand the initiating grant", () => {
  const ctx = context(["read_file"]);
  ctx.set(AuthKey, principal(["bash", "ask_question", "read_file"]));
  const { runInput } = buildSubagentRunInput({
    action: { callId: "delegate", nodeId: "root", subagentName: "agent", input: { message: "Inspect" } },
    auth: ctx.get(AuthKey), initiatorAuth: ctx.get(InitiatorAuthKey),
    source: { type: "runtime" }, continuationKey: "policy-child",
    parent: { lineage: { rootSessionId: "root-session" } },
    session: { sessionId: "parent-session" },
  });
  assert.deepEqual(runInput.initiatorAuth, ctx.get(InitiatorAuthKey));
  const delegatedContext = new ContextContainer();
  delegatedContext.set(InitiatorAuthKey, runInput.initiatorAuth);
  delegatedContext.set(AuthKey, runInput.auth);
  assert.deepEqual([...catalog(delegatedContext, agentTools, "root-session").entries.keys()], ["read_file"]);
  const child = catalog(ctx, agentTools, "root-session");
  assert.deepEqual([...child.entries.keys()], ["read_file"]);
  const restored = new ContextContainer();
  // Durable auth, rather than a process-local cache, is the authority.
  restored.set(InitiatorAuthKey, ctx.get(InitiatorAuthKey));
  restored.set(AuthKey, ctx.get(AuthKey));
  assert.deepEqual([...catalog(restored).entries.keys()], ["read_file"]);
});

test("a parked approval cannot execute a tool omitted on reconstruction", async () => {
  let executed = false;
  const tools = new Map([["bash", definition("bash", { execute: () => { executed = true; } })]]);
  const events: unknown[] = [];
  await runApprovedCalls({
    approvals: [{ call: { callId: "parked", toolName: "bash", input: {} } }],
    messages: [], tools: catalog(context([]), tools),
    publish: async (event: unknown) => { events.push(event); },
    view: () => ({}),
  });
  assert.equal(executed, false);
  assert.equal(events.length, 1, "the unavailable call is settled instead of left pending");
});

test("MCP connections keep their separate grant when optional tools are disabled", () => {
  const ctx = context([]);
  ctx.set(ConnectionRegistryKey, { getConnections: () => [{ connectionName: "host_mcp", description: "Host MCP" }] });
  const selected = catalog(ctx);
  assert.ok(selected.resolve({ toolName: "eve__tool", input: { name: "host_mcp__query", input: {} } }));
  assert.equal(selected.get("bash"), undefined);
});

test("malformed durable tool grants fail closed", () => {
  for (const agentRunPolicy of ["{broken", "null", "[]", '{"tools":null}', '{"tools":[1]}', 42]) {
    const ctx = context();
    ctx.set(InitiatorAuthKey, { attributes: { agentRunPolicy } });
    assert.throws(() => catalog(ctx), /Invalid AgentRun tool policy/);
  }
});

test("out-of-conversation invocation also enforces the grant before executing", async () => {
  let executed = 0;
  const runtime = {
    compiledArtifactsSource: { kind: "bundled" },
    agentName: "policy-test", origin: "http://localhost", nodeId: "root",
    callbackBaseUrl: "http://localhost", sandboxRegistry: { sandbox: null },
    manifest: { bindings: { host: { owner: { kind: "app" } } },
      tools: [{ name: "host_invoke", sourceId: "host", hasExecute: true }] },
    tools: new Map([["host_invoke", definition("host_invoke", { execute: () => { executed++; return { ok: true }; } })]]),
  };
  const denied = await invokeTool(runtime, "host_invoke", {}, { auth: principal([]) });
  assert.equal(denied.outcome, "rejected", JSON.stringify(denied));
  assert.match(denied.reason, /disabled/);
  assert.equal(executed, 0);
  const allowed = await invokeTool(runtime, "host_invoke", {}, { auth: principal(["host_invoke"]) });
  assert.equal(allowed.outcome, "completed");
  assert.equal(executed, 1);
});
