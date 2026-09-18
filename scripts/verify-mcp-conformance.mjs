import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "eve/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";

assert.equal(
  Number(process.versions.node.split(".")[0]),
  24,
  "MCP conformance must run on the supported Node.js 24 runtime.",
);

const root = resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(join(root, "examples/.mcp-conformance-"));
const agentRoot = join(tempRoot, "agent");
const serviceToken = "mcp-broker-service-token-never-exported";
const credential = "mcp-third-party-credential-never-exported";
const tenantId = "tenant-mcp-conformance";
const adapter = { id: "conformance-mcp", version: "1.0.0" };
const effects = { hiddenDelete: 0, read: 0, write: 0 };
const requests = { broker: [], mcp: [] };
let installation = "enabled";
let eve;
const evePort = await freePort();

const brokerServer = createServer(async (request, response) => {
  const body = await readBody(request);
  requests.broker.push({
    authorization: request.headers.authorization,
    body,
  });
  if (request.headers.authorization !== `Bearer ${serviceToken}`) {
    response.writeHead(401).end();
    return;
  }
  const parsed = JSON.parse(body);
  const allowed = installation === "enabled" &&
    parsed.adapter?.id === adapter.id &&
    parsed.adapter?.version === adapter.version &&
    parsed.subject?.tenantId === tenantId;
  if (!allowed) {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "revoked" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ expiresAt: Date.now() + 60_000, token: credential }));
});
const brokerPort = await listen(brokerServer);

const mcpServer = createServer(async (request, response) => {
  requests.mcp.push({ authorization: request.headers.authorization, method: request.method });
  if (request.headers.authorization !== `Bearer ${credential}`) {
    response.writeHead(401).end();
    return;
  }
  const server = createFixtureMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const body = request.method === "POST" ? await readBody(request) : undefined;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
  }
  const fetchResponse = await transport.handleRequest(new Request(
    `http://127.0.0.1:${mcpPort}${request.url ?? "/mcp"}`,
    { body, headers, method: request.method },
  ));
  response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers));
  response.end(Buffer.from(await fetchResponse.arrayBuffer()));
  await transport.close();
  await server.close();
});
const mcpPort = await listen(mcpServer);

try {
  await scaffoldFixtureAgent({ agentRoot, brokerPort, mcpPort });
  await runNode([
    resolve(root, "node_modules/eve/bin/eve.js"),
    "build",
    "--skip-sandbox-prewarm",
  ], {
    cwd: tempRoot,
    env: fixtureEnvironment(),
  });
  await assertDirectoryExcludes(join(tempRoot, ".output"), [credential, serviceToken]);

  eve = spawnNode([
    resolve(root, "node_modules/eve/bin/eve.js"),
    "start",
    "--port",
    String(evePort),
  ], {
    cwd: tempRoot,
    env: fixtureEnvironment(),
  });
  const eveUrl = `http://127.0.0.1:${evePort}`;
  await waitFor(`${eveUrl}/eve/v1/health`, 60_000);
  const client = new Client({
    headers: {
      "x-agent-model": "fixture",
      "x-agent-profile-id": "general-purpose",
      "x-agent-profile-version": "0.1.0",
      "x-agent-run-policy": Buffer.from(JSON.stringify({ mcpConnections: [adapter] })).toString("base64url"),
      "x-fixture-agent-run-policy": JSON.stringify({ mcpConnections: [adapter] }),
      "x-fixture-tenant-id": tenantId,
    },
    host: eveUrl,
  });

  const { session, response: readResponse } = await client.sessions.create({
    message: "EVAL_MCP_READ",
  });
  const readTurn = await readResponse.result();
  assert.equal(readTurn.message, "MCP_READ_COMPLETED");
  assert.equal(effects.read, 1);
  assert.equal(effects.hiddenDelete, 0);
  assert.ok(requests.mcp.some((request) => request.authorization === `Bearer ${credential}`));

  const writePending = await (await session.send("EVAL_MCP_WRITE")).result();
  assert.equal(writePending.status, "waiting");
  const approvalRequest = findApprovalRequest(writePending);
  assert.ok(approvalRequest, "write MCP tool did not park for durable approval");
  assert.equal(effects.write, 0);
  const writeComplete = await (await session.respond([
    { optionId: "approve", requestId: approvalRequest.requestId },
  ])).result();
  assert.equal(writeComplete.message, "MCP_WRITE_COMPLETED");
  assert.equal(effects.write, 1);

  installation = "revoked";
  const brokerRequestsBeforeRevocation = requests.broker.length;
  const mcpRequestsBeforeRevocation = requests.mcp.length;
  const revokedTurn = await (await session.send("EVAL_MCP_READ")).result();
  assert.notEqual(revokedTurn.message, "MCP_READ_COMPLETED");
  assert.notEqual(revokedTurn.message, "MCP_CREDENTIAL_LEAK_DETECTED");
  assert.ok(requests.broker.length > brokerRequestsBeforeRevocation);
  assert.equal(requests.mcp.length, mcpRequestsBeforeRevocation);

  installation = "enabled";
  const deniedPolicyClient = new Client({
    headers: {
      "x-agent-model": "fixture",
      "x-agent-profile-id": "general-purpose",
      "x-agent-profile-version": "0.1.0",
      "x-agent-run-policy": Buffer.from(JSON.stringify({ mcpConnections: [] })).toString("base64url"),
      "x-fixture-agent-run-policy": JSON.stringify({ mcpConnections: [] }),
      "x-fixture-tenant-id": tenantId,
    },
    host: eveUrl,
  });
  const brokerRequestsBeforeDeniedPolicy = requests.broker.length;
  const { response: deniedPolicyResponse } = await deniedPolicyClient.sessions.create({
    message: "EVAL_MCP_READ",
  });
  const deniedPolicyTurn = await deniedPolicyResponse.result();
  assert.notEqual(deniedPolicyTurn.message, "MCP_READ_COMPLETED");
  assert.equal(requests.broker.length, brokerRequestsBeforeDeniedPolicy);

  const crossTenantClient = new Client({
    headers: {
      "x-agent-model": "fixture",
      "x-agent-profile-id": "general-purpose",
      "x-agent-profile-version": "0.1.0",
      "x-agent-run-policy": Buffer.from(JSON.stringify({ mcpConnections: [adapter] })).toString("base64url"),
      "x-fixture-agent-run-policy": JSON.stringify({ mcpConnections: [adapter] }),
      "x-fixture-tenant-id": "tenant-mcp-conformance-other",
    },
    host: eveUrl,
  });
  const brokerRequestsBeforeCrossTenant = requests.broker.length;
  const crossTenantSession = crossTenantClient.sessions.attach(session.state.sessionId, {
    streamIndex: session.state.streamIndex,
  });
  const crossTenantTurn = await (await crossTenantSession.send("EVAL_MCP_READ")).result();
  assert.notEqual(crossTenantTurn.message, "MCP_READ_COMPLETED");
  assert.equal(requests.broker.length, brokerRequestsBeforeCrossTenant);
  assert.equal(effects.hiddenDelete, 0);

  for (const request of requests.broker) {
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body).sort(), ["adapter", "contractVersion", "sessionId", "subject"]);
    assert.deepEqual(Object.keys(body.adapter).sort(), ["id", "version"]);
    assert.deepEqual(Object.keys(body.subject).sort(), ["actorType", "principalId", "tenantId"]);
  }

  const serializedEvidence = JSON.stringify({
    brokerRequests: requests.broker.length,
    crossTenant: crossTenantTurn.message,
    deniedPolicy: deniedPolicyTurn.message,
    mcpRequests: requests.mcp.length,
    read: readTurn.message,
    revoked: revokedTurn.message,
    write: writeComplete.message,
  });
  assert.doesNotMatch(serializedEvidence, new RegExp(escapeRegExp(credential)));
  assert.doesNotMatch(serializedEvidence, new RegExp(escapeRegExp(serviceToken)));
  const eventEvidence = JSON.stringify([
    ...readTurn.events,
    ...writePending.events,
    ...writeComplete.events,
    ...revokedTurn.events,
    ...deniedPolicyTurn.events,
    ...crossTenantTurn.events,
  ]);
  assert.doesNotMatch(eventEvidence, new RegExp(escapeRegExp(credential)));
  assert.doesNotMatch(eventEvidence, new RegExp(escapeRegExp(serviceToken)));
  console.log("Open Agent MCP conformance passed.");
  console.log(serializedEvidence);
} finally {
  eve?.kill("SIGTERM");
  await Promise.allSettled([
    eve ? once(eve, "exit") : Promise.resolve(),
    close(brokerServer),
    close(mcpServer),
  ]);
  await rm(tempRoot, { force: true, recursive: true });
}

function createFixtureMcpServer() {
  const server = new McpServer({ name: "open-agent-conformance", version: "1.0.0" });
  server.registerTool("read_record", {
    description: "Read a record by key.",
    inputSchema: { key: z.string() },
  }, async ({ key }) => {
    effects.read += 1;
    return { content: [{ type: "text", text: `record:${key}` }] };
  });
  server.registerTool("write_record", {
    description: "Write a record by key.",
    inputSchema: { key: z.string(), value: z.string() },
  }, async ({ key, value }) => {
    effects.write += 1;
    return { content: [{ type: "text", text: `written:${key}:${value}` }] };
  });
  server.registerTool("hidden_delete", {
    description: "Delete every record. This must never be discoverable.",
    inputSchema: {},
  }, async () => {
    effects.hiddenDelete += 1;
    return { content: [{ type: "text", text: "deleted" }] };
  });
  return server;
}

async function scaffoldFixtureAgent({ agentRoot, brokerPort, mcpPort }) {
  await writeFile(join(tempRoot, "package.json"), JSON.stringify({
    name: "open-agent-mcp-conformance-fixture",
    private: true,
    type: "module",
    dependencies: {
      "@oworker/open-agent-mcp-adapter": "0.1.0-alpha.9",
      eve: "0.56.0",
    },
  }, null, 2));
  await writeFile(join(tempRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      target: "ES2022",
    },
    include: ["agent/**/*.ts"],
  }, null, 2));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(agentRoot, "channels"), { recursive: true });
  await mkdir(join(agentRoot, "connections"), { recursive: true });
  await writeFile(join(agentRoot, "agent.ts"), `
import { defineAgent } from "eve";
import { createMcpEvalModel } from ${JSON.stringify(resolve(root, "evals/mcp-fixture-model.ts"))};
export default defineAgent({
  model: createMcpEvalModel(),
  modelContextWindowTokens: 32768,
});
`);
  await writeFile(
    join(agentRoot, "instructions.md"),
    "Use only the requested conformance connection tools.\n",
  );
  await writeFile(join(agentRoot, "channels/eve.ts"), `
import { eveChannel } from "eve/channels/eve";
export default eveChannel({ auth: (request) => ({
  attributes: {
    agentRunPolicy: request.headers.get("x-fixture-agent-run-policy") ?? "{}",
    actorType: "user",
    tenantId: request.headers.get("x-fixture-tenant-id") ?? "",
  },
  authenticator: "fixture",
  principalId: "fixture-user",
  principalType: "user",
}) });
`);
  await writeFile(join(agentRoot, "connections/gateway.ts"), `
import { createBrokeredMcpConnection } from "@oworker/open-agent-mcp-adapter";
export default createBrokeredMcpConnection({
  adapter: ${JSON.stringify(adapter)},
  broker: {
    getServiceToken: () => process.env.MCP_FIXTURE_BROKER_TOKEN!,
    timeoutMs: 5000,
    url: "http://127.0.0.1:${brokerPort}/credentials",
  },
  connection: {
    description: "Conformance record read and write tools.",
    displayName: "Conformance tools",
    endpoint: "http://127.0.0.1:${mcpPort}/mcp",
    tools: {
      allow: ["read_record", "write_record"],
      requireApproval: ["write_record"],
    },
  },
});
`);
}

function fixtureEnvironment() {
  const environment = {
    ...process.env,
    MCP_FIXTURE_BROKER_TOKEN: serviceToken,
    MCP_FIXTURE_CREDENTIAL: credential,
    NODE_ENV: "production",
  };
  delete environment.AGENT_EVAL_FIXTURE_MODEL;
  delete environment.AGENT_SANDBOX_BACKEND;
  return environment;
}

function spawnNode(args, options) {
  return spawn(process.execPath, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runNode(args, options) {
  const child = spawnNode(args, options);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(output);
  return output;
}

function findApprovalRequest(result) {
  for (const request of result.inputRequests ?? []) {
    if (isApprovalRequest(request)) return request;
  }
  for (const event of result.events) {
    if (event.type !== "input.requested") continue;
    const requests = event.data?.requests;
    if (!Array.isArray(requests)) continue;
    const request = requests.find(isApprovalRequest);
    if (request) return request;
  }
}

function isApprovalRequest(candidate) {
  return Boolean(
    candidate &&
    typeof candidate.requestId === "string" &&
    candidate.action?.kind === "tool-call" &&
    Array.isArray(candidate.options) &&
    candidate.options.some((option) => option?.id === "approve") &&
    candidate.options.some((option) => option?.id === "deny" || option?.id === "cancel"),
  );
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${url} did not become ready within ${timeoutMs}ms.`);
}

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await close(server);
  return port;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function assertDirectoryExcludes(directory, markers) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const contents = await readFile(join(entry.parentPath, entry.name));
    const text = contents.toString("utf8");
    for (const marker of markers) {
      assert.equal(text.includes(marker), false, `${entry.name} contains a credential marker.`);
    }
  }
}
