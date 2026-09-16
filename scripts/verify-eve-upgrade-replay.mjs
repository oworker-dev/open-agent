import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Only disposable databases are accepted. Never run an upgrade probe on user data.
const database = new URL(process.env.WORKFLOW_POSTGRES_URL ?? "");
assert.ok(database.pathname.endsWith("_eve_migration_test") || database.pathname.endsWith("_eve_upgrade_test"),
  "WORKFLOW_POSTGRES_URL must name an isolated *_eve_migration_test or *_eve_upgrade_test database.");
const app = process.cwd();
const oldApp = resolve(process.env.EVE_UPGRADE_OLD_APP ?? app);
const port = Number(process.env.EVE_UPGRADE_TEST_PORT ?? 42893);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65533);
const secret = "isolated-eve-upgrade-mailbox-test-secret";
const base = `http://127.0.0.1:${port}`;
const captures = [];
const logs = [];
let runtime;
let provider;
const environment = {
  ...process.env,
  AGENT_DATABASE_URL: "", AGENT_HOST_JWT_SECRET: "", AGENT_HOST_JWT_ISSUER: "", AGENT_HOST_JWT_AUDIENCE: "",
  AGENT_MAILBOX_DISPATCH_SECRET: secret, AGENT_SANDBOX_BACKEND: "docker",
  EVE_DEV: "1", EVE_TELEMETRY_DISABLED: "1", NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(port),
  OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: `http://127.0.0.1:${port + 1}/v1`,
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres", WORKFLOW_POSTGRES_URL: database.href,
  WORKFLOW_POSTGRES_JOB_PREFIX: "migration_probe_", WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "4", WORKFLOW_POSTGRES_MAX_POOL_SIZE: "8",
};
const proxy = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const part of request) body += part;
    if (body) captures.push(JSON.parse(body));
    const upstream = await fetch(`http://127.0.0.1:${port + 2}${request.url}`, {
      method: request.method, headers: { "content-type": "application/json" }, ...(body ? { body } : {}),
    });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    for await (const part of upstream.body) response.write(part);
    response.end();
  } catch (error) { response.writeHead(500).end(String(error)); }
});

try {
  await new Promise((done, reject) => { proxy.once("error", reject); proxy.listen(port + 1, "127.0.0.1", done); });
  provider = child(app, "scripts/mock-openai-responses.mjs", { MOCK_OPENAI_PORT: String(port + 2) });
  await ready(`http://127.0.0.1:${port + 2}/v1/models`);
  await setup(oldApp);
  runtime = child(oldApp, ".output/server/index.mjs");
  await ready(`${base}/eve/v1/health`);
  const sessionId = await send(undefined, "MIGRATION_PREFIX. Do not call tools. Reply exactly: BEFORE_UPGRADE");
  let history = await settled(sessionId);
  await send(sessionId, "MIGRATION_OLD_BRANCH. Do not call tools. Reply exactly: OLD_BRANCH");
  history = await settled(sessionId, history.length);
  console.log(JSON.stringify({ stage: "before-restart", sessionId, events: history.length }));
  await stop(runtime);
  runtime = undefined;
  await setup(app);
  runtime = child(app, ".output/server/index.mjs");
  await ready(`${base}/eve/v1/health`);
  await send(sessionId, "MIGRATION_NEW_TURN. Do not call tools. Reply exactly: AFTER_UPGRADE");
  history = await settled(sessionId, history.length);
  assert.equal(history.filter((event) => event.type === "message.completed").at(-1)?.data.message, "AFTER_UPGRADE");
  assert.match(JSON.stringify(captures.at(-1)?.input), /MIGRATION_PREFIX/);
  assert.match(JSON.stringify(captures.at(-1)?.input), /MIGRATION_OLD_BRANCH/);
  const target = history.findLast((event) => event.type === "message.received");
  await mailbox({
    action: "deliver", sessionId, clientMessageId: "migration-edit", operationId: "migration-edit", itemId: "migration-edit",
    operationKind: "edit", beforeTurnId: target.data.turnId, principalId: "migration-test", principalType: "user", tenantId: "migration-test",
    message: "MIGRATION_EDIT. Do not call tools. Reply exactly: EDITED",
  });
  history = await settled(sessionId, history.length);
  const editedInput = JSON.stringify(captures.at(-1)?.input);
  assert.match(editedInput, /MIGRATION_PREFIX/);
  assert.match(editedInput, /MIGRATION_OLD_BRANCH/);
  assert.doesNotMatch(editedInput, /MIGRATION_NEW_TURN|AFTER_UPGRADE/);
  assert.match(editedInput, /MIGRATION_EDIT/);
  assert.ok(history.some((event) => event.type === "context.cleared"));
  assert.ok(history.some((event) => event.type === "message.received" && event.data.clientMessageId === "migration-edit"));
  console.log(JSON.stringify({ ok: true, sessionId, events: history.length, modelContextRewound: true }));
} catch (error) {
  console.error(logs.join("").slice(-22000));
  throw error;
} finally {
  await stop(runtime);
  await stop(provider);
  proxy.closeAllConnections();
  await new Promise((done) => proxy.close(done));
}

function child(root, script, extra = {}) {
  const process = spawn(globalThis.process.execPath, [script], { cwd: root, env: { ...environment, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.on("data", (chunk) => logs.push(String(chunk)));
  process.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return process;
}
async function setup(root) {
  const process = child(root, "node_modules/@workflow/world-postgres/dist/cli.js");
  await new Promise((done, reject) => process.once("exit", (code) => code === 0 ? done() : reject(new Error("Test database setup failed"))));
}
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([new Promise((done) => process.once("exit", done)), delay(2500)]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await new Promise((done) => process.once("exit", done));
  }
}
async function ready(url) {
  for (let index = 0; index < 100; index++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Not ready: ${url}`);
}
async function mailbox(input) {
  const body = JSON.stringify(input);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
  const response = await fetch(`${base}/eve/v1/internal/mailbox`, {
    method: "POST", signal: AbortSignal.timeout(15000), body,
    headers: { "content-type": "application/json", "x-agent-mailbox-timestamp": timestamp, "x-agent-mailbox-signature": `sha256=${signature}` },
  });
  const text = await response.text();
  assert.ok(response.ok, text);
  return input.action === "transcript" ? text.trim().split("\n").filter(Boolean).map(JSON.parse) : JSON.parse(text);
}
async function settled(sessionId, previous = 0) {
  for (let index = 0; index < 200; index++) {
    const events = await mailbox({ action: "transcript", sessionId, startIndex: 0 });
    if (events.length > previous && events.at(-1)?.type === "session.waiting") return events;
    assert.ok(!events.some((event) => event.type === "session.failed"), JSON.stringify(events.slice(-3)));
    await delay(150);
  }
  throw new Error(`Session did not settle: ${sessionId}`);
}
async function send(sessionId, message) {
  const response = await fetch(`${base}/eve/v1/session${sessionId ? `/${sessionId}` : ""}`, {
    method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" }, body: JSON.stringify({ message }),
  });
  assert.ok(response.ok, await response.clone().text());
  return (await response.json()).sessionId;
}
