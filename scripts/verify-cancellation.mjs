import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "eve/client";

// Exercise the real harness and transport, not an in-browser simulated cancel.
// Use a disposable WORKFLOW_POSTGRES_URL for VERIFY_EVE_BUILT_RUNTIME=1.
const root = process.cwd();
const fixture = await mkdtemp(join(tmpdir(), "open-agent-cancellation-"));
const built = process.env.VERIFY_EVE_BUILT_RUNTIME === "1";
const providerPort = await freePort();
const evePort = await freePort();
const providerUrl = `http://127.0.0.1:${providerPort}`;
const eveUrl = `http://127.0.0.1:${evePort}`;
const exec = promisify(execFile);
const children = [];
const sessions = [];
const logs = new Map();
const budgetMs = Number(process.env.VERIFY_CANCELLATION_BUDGET_MS || 2_000);
const measurements = [];

try {
  for (const directory of ["agent", "evals", "lib", "packages", "server"]) {
    await cp(resolve(root, directory), join(fixture, directory), { recursive: true, dereference: true });
  }
  for (const file of ["package.json", "tsconfig.json", "instrumentation.ts"]) await cp(resolve(root, file), join(fixture, file));
  await symlink(resolve(root, "node_modules"), join(fixture, "node_modules"), "dir");
  launch("provider", [resolve(root, "scripts/mock-openai-responses.mjs")], { MOCK_OPENAI_PORT: String(providerPort) });
  await until(async () => (await fetch(`${providerUrl}/v1/models`)).ok, 20_000);
  launch("eve", built ? [resolve(root, ".output/server/index.mjs")] : [
    resolve(root, "node_modules/eve/bin/eve.js"), "dev", "--no-ui", "--no-default-extensions", "--port", String(evePort),
  ], {
    AGENT_DATABASE_URL: "", AGENT_EVAL_FIXTURE_MODEL: "", AGENT_BASH_APPROVAL_MODE: "never",
    AGENT_HOST_JWT_AUDIENCE: "", AGENT_HOST_JWT_ISSUER: "", AGENT_HOST_JWT_SECRET: "",
    AGENT_HOST_TOOLS_SECRET: "", AGENT_HOST_TOOLS_URL: "", AGENT_SANDBOX_BACKEND: "docker",
    AGENT_SANDBOX_IDLE_TIMEOUT_MS: "60000", AGENT_SANDBOX_MAX_ACTIVE: "2",
    AGENT_PROVIDER_HTTP_TIMEOUT_MS: "90000", EVE_DEV: "1", NODE_ENV: "development",
    HOST: "127.0.0.1", PORT: String(evePort), OPENAI_API_KEY: "cancellation-fixture-key",
    OPENAI_BASE_URL: `${providerUrl}/v1`, WORKFLOW_TARGET_WORLD: built ? "@workflow/world-postgres" : "",
  });
  await until(async () => (await fetch(`${eveUrl}/eve/v1/health`)).ok, 180_000);
  const client = new Client({ baseUrl: eveUrl });
  for (const scenario of (process.env.VERIFY_CANCELLATION_SCENARIOS || "WAIT_HEADERS,STREAM,COMMAND").split(",")) {
    const { session, delivery } = await client.sessions.create({ message: `CANCELLATION_${scenario}` });
    sessions.push(session);
    const events = [];
    const reading = (async () => { for await (const event of delivery.stream()) events.push(event); })();
    reading.catch(() => undefined);
    const providerState = () => fetch(`${providerUrl}/debug/state`).then((r) => r.json());
    await until(async () => (await providerState()).cancellations.some((r) => r.scenario === `CANCELLATION_${scenario}`), 60_000);
    if (scenario === "STREAM") await until(() => events.some((e) => e.type === "content.delta"), 20_000);
    const turnId = await until(() => events.find((e) => e.type === "turn.started")?.data.turnId, 20_000);
    let container;
    if (scenario === "COMMAND") {
      container = await until(async () => {
        const { stdout } = await exec("docker", ["ps", "-q", "--filter", `label=eve.sandbox.tag.sessionId=${session.state.sessionId}`]);
        const id = stdout.trim();
        if (!id) return;
        const { stdout: ready } = await exec("docker", ["exec", id, "test", "-f", "/workspace/cancellation-ready"]).then(() => ({ stdout: "ready" })).catch(() => ({ stdout: "" }));
        return ready ? id : undefined;
      }, 60_000);
    }
    assert(!events.some((e) => e.type === "turn.settled" && e.data.turnId === turnId), "The test turn completed before cancellation.");
    const startedAt = Date.now();
    const cancellation = await session.cancel({ turnId });
    const acceptedMs = Date.now() - startedAt;
    // Deliberately send before cancellation settles. Native queue semantics
    // must keep the new message out of the old turn.
    const next = await session.send("CANCELLATION_CONTINUE", { turnPolicy: "queue" });
    const nextEvents = [];
    const nextReading = (async () => { for await (const e of next.stream()) nextEvents.push(e); })();
    nextReading.catch(() => undefined);
    try {
      await until(() => events.some((e) => e.type === "turn.settled" && e.data.turnId === turnId), 20_000);
    } catch (error) {
      console.error(JSON.stringify({ scenario, events, provider: await providerState() }));
      throw error;
    }
    const settledMs = Date.now() - startedAt;
    await Promise.race([reading, deadline(20_000)]);
    await Promise.race([nextReading, deadline(20_000)]);
    const continuedMs = Date.now() - startedAt;
    assert(events.some((e) => e.type === "turn.settled" && e.data.turnId === turnId && e.data.outcome === "cancelled"), JSON.stringify({ scenario, startedAt, acceptedMs, settledMs, events }));
    assert(nextEvents.some((e) => e.type === "turn.settled" && e.data.outcome === "completed"));
    assert(!nextEvents.some((e) => e.type === "turn.started" && e.data.turnId === turnId));
    const state = await providerState();
    const record = state.cancellations.findLast((r) => r.scenario === `CANCELLATION_${scenario}`);
    const closedMs = scenario !== "COMMAND" && record.closedAt ? record.closedAt - startedAt : null;
    if (scenario !== "COMMAND") assert.notEqual(closedMs, null, "The provider request was left running after cancellation.");
    if (container) {
      const { stdout } = await exec("docker", ["exec", container, "sh", "-c", "test ! -e /workspace/cancellation-late && ! ps -eo args | grep '^sleep 60$'"]);
      assert.equal(stdout, "", "The cancelled shell command is still running.");
    }
    const measurement = { scenario, acceptedMs, settledMs, continuedMs, providerClosedMs: closedMs, sessionId: session.state.sessionId, deliveryId: cancellation.deliveryId };
    measurements.push(measurement);
    console.log(JSON.stringify(measurement));
    assert(settledMs < budgetMs, `${scenario}: cancellation took ${settledMs}ms (budget ${budgetMs}ms).`);
  }
  console.log(JSON.stringify({ ok: true, world: built ? "postgres" : "local", measurements }));
} catch (error) {
  for (const [name, output] of logs) console.error(`[${name} tail]\n${output.slice(-30_000)}`);
  throw error;
} finally {
  for (const session of sessions) await session.reset({ reason: "cancellation-verification-cleanup", signal: AbortSignal.timeout(3_000) }).catch(() => undefined);
  for (const child of children.reverse()) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const session of sessions) {
    const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `label=eve.sandbox.tag.sessionId=${session.state.sessionId}`]).catch(() => ({ stdout: "" }));
    const ids = stdout.split(/\s/u).filter(Boolean);
    if (ids.length) await exec("docker", ["rm", "-f", ...ids]);
  }
  await rm(fixture, { recursive: true, force: true });
}

function launch(name, args, environment) {
  const child = spawn(process.execPath, args, { cwd: fixture, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); logs.set(name, "");
  const record = (chunk) => logs.set(name, `${logs.get(name)}${chunk}`.slice(-30_000));
  child.stdout.on("data", record); child.stderr.on("data", record);
  return child;
}
async function until(read, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await read(); } catch { /* startup or a not-yet-ready fixture */ }
    if (value) return value;
    assert(Date.now() < end, `Cancellation verification timed out after ${timeoutMs}ms.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function deadline(ms) { return new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`Cancellation exceeded ${ms}ms.`)), ms); t.unref(); }); }
function freePort() { return new Promise((resolvePort, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolvePort(port)); }); }); }
