import { execFile, spawn } from "node:child_process";
import { copyFile, cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "eve/client";

const projectRoot = process.cwd();
const isolatedAppRoot = await createIsolatedAppRoot(projectRoot);
const providerPort = await freePort();
const evePort = await freePort();
const providerUrl = `http://127.0.0.1:${providerPort}`;
const eveUrl = `http://127.0.0.1:${evePort}`;
const childLogs = new Map();
const children = [];
const syntheticSessionIds = new Set();
const execFileAsync = promisify(execFile);

try {
  children.push(spawnLogged("provider", process.execPath, [resolve("scripts/mock-openai-responses.mjs")], {
    ...process.env,
    MOCK_OPENAI_PORT: String(providerPort),
    MOCK_PROVIDER_STALL_MS: "5000",
  }));
  await waitFor(`${providerUrl}/v1/models`);

  children.push(spawnLogged("eve", process.execPath, [
    resolve("node_modules/eve/bin/eve.js"), "dev", "--no-ui", "--port", String(evePort),
  ], {
    ...process.env,
    AGENT_DATABASE_URL: "",
    AGENT_EVAL_FIXTURE_MODEL: "",
    AGENT_HOST_JWT_AUDIENCE: "",
    AGENT_HOST_JWT_ISSUER: "",
    AGENT_HOST_JWT_SECRET: "",
    AGENT_HOST_TOOLS_SECRET: "",
    AGENT_HOST_TOOLS_URL: "",
    AGENT_PROVIDER_HTTP_TIMEOUT_MS: "3000",
    AGENT_SANDBOX_ADMISSION_TIMEOUT_MS: "30000",
    AGENT_SANDBOX_IDLE_TIMEOUT_MS: "60000",
    AGENT_SANDBOX_MAX_ACTIVE: "1",
    AGENT_SANDBOX_MAX_QUEUED: "1024",
    AGENT_SANDBOX_BACKEND: "docker",
    NODE_ENV: "development",
    OPENAI_API_KEY: "mock-provider-key",
    OPENAI_BASE_URL: `${providerUrl}/v1`,
    WORKFLOW_TARGET_WORLD: "",
  }, isolatedAppRoot));
  await waitFor(`${eveUrl}/eve/v1/health`, 60_000);

  const rateLimit = await completedTurn(eveUrl,
    "PROVIDER_429_RECOVER. Do not use tools. Reply exactly: RATE_LIMIT_RECOVERED");
  assert(messageText(rateLimit) === "RATE_LIMIT_RECOVERED", "429 recovery returned the wrong result.");

  const temporaryNotFound = await completedTurn(eveUrl,
    "PROVIDER_404_RECOVER. Do not use tools. Reply exactly: NOT_FOUND_RECOVERED");
  assert(messageText(temporaryNotFound) === "NOT_FOUND_RECOVERED",
    "The temporary 404 provider route did not recover automatically.");

  const exhaustedNotFound = await createAndConsume(eveUrl,
    "PROVIDER_404_THREE. Reply exactly: STALE");
  assertRecoverableFailure(exhaustedNotFound.events, "exhausted temporary 404 provider route");
  const resumedAfterNotFound = await consume(
    exhaustedNotFound.session,
    "Continue the same task. Reply exactly: NOT_FOUND_CONTINUED",
  );
  assertCompleted(resumedAfterNotFound, "exhausted temporary 404 continuation");
  assert(completedMessageText(resumedAfterNotFound) === "NOT_FOUND_CONTINUED",
    "The session did not continue after exhausting the temporary 404 retry budget.");

  const serverError = await completedTurn(eveUrl,
    "PROVIDER_500_RECOVER. Do not use tools. Reply exactly: SERVER_ERROR_RECOVERED");
  assert(messageText(serverError) === "SERVER_ERROR_RECOVERED", "500 recovery returned the wrong result.");

  const requestTimeout = await completedTurn(eveUrl,
    "PROVIDER_408_RECOVER. Do not use tools. Reply exactly: REQUEST_TIMEOUT_RECOVERED");
  assert(messageText(requestTimeout) === "REQUEST_TIMEOUT_RECOVERED", "408 recovery returned the wrong result.");

  const timeoutRecovered = await completedTurn(eveUrl,
    "PROVIDER_STALL_ONCE. Reply exactly: TIMEOUT_RECOVERED");
  assert(completedMessageText(timeoutRecovered) === "TIMEOUT_RECOVERED",
    "The transient Provider timeout did not recover automatically.");

  const interrupted = await completedTurn(eveUrl,
    "PROVIDER_STREAM_INTERRUPT_ONCE. Reply exactly: STREAM_RECOVERED");
  assert(
    interrupted.some((event) =>
      event.type === "message.appended" && event.data.messageDelta.includes("PARTIAL_BEFORE_INTERRUPT")
    ),
    "The interrupted stream did not expose its partial output for diagnosis.",
  );
  assert(completedMessageText(interrupted) === "STREAM_RECOVERED",
    "The pre-tool stream interruption did not recover automatically.");

  // Exercise the real Eve sandbox lifecycle with a single permit. A reset
  // must close the active handle and release that permit before the next
  // session can execute its bash tool; otherwise this deterministic check
  // would hang until the admission timeout.
  const firstSandbox = await createAndConsume(
    eveUrl,
    "SANDBOX_LIFECYCLE_E2E. Use the requested sandbox tool, then reply exactly: SANDBOX_FIRST",
  );
  assertCompleted(firstSandbox.events, "first sandbox lifecycle turn");
  assert(
    firstSandbox.events.some((event) => event.type === "action.result" && event.data?.status === "completed"),
    "The first sandbox lifecycle turn did not complete its action.",
  );
  await firstSandbox.session.reset({ reason: "sandbox-lifecycle-first" });
  const secondSandbox = await createAndConsume(
    eveUrl,
    "SANDBOX_LIFECYCLE_E2E. Use the requested sandbox tool, then reply exactly: SANDBOX_SECOND",
  );
  assertCompleted(secondSandbox.events, "second sandbox lifecycle turn");
  assert(
    secondSandbox.events.some((event) => event.type === "action.result" && event.data?.status === "completed"),
    "The second sandbox lifecycle turn did not complete its action after reset.",
  );
  await secondSandbox.session.reset({ reason: "sandbox-lifecycle-second" });

  const { events: exhausted, session: exhaustedSession } = await createAndConsume(
    eveUrl,
    "PROVIDER_STALL_THREE. Reply exactly: STALE",
  );
  assertRecoverableFailure(exhausted, "exhausted provider timeout");
  const resumedAfterExhaustion = await consume(
    exhaustedSession,
    "Continue the same task. Reply exactly: EXHAUSTED_TIMEOUT_RECOVERED",
  );
  assertCompleted(resumedAfterExhaustion, "exhausted timeout continuation");
  assert(completedMessageText(resumedAfterExhaustion) === "EXHAUSTED_TIMEOUT_RECOVERED",
    "The session did not continue after exhausting the transient retry budget.");

  const state = await fetch(`${providerUrl}/debug/state`).then((response) => response.json());
  assert(state.scenarioAttempts.PROVIDER_429_RECOVER === 3,
    `Expected three 429 attempts, received ${state.scenarioAttempts.PROVIDER_429_RECOVER}.`);
  assert(state.scenarioAttempts.PROVIDER_404_RECOVER === 3,
    `Expected three 404 attempts, received ${state.scenarioAttempts.PROVIDER_404_RECOVER}.`);
  assert(state.scenarioAttempts.PROVIDER_404_THREE === 3,
    `Expected three exhausted 404 attempts, received ${state.scenarioAttempts.PROVIDER_404_THREE}.`);
  assert(state.scenarioAttempts.PROVIDER_500_RECOVER === 3,
    `Expected three 500 attempts, received ${state.scenarioAttempts.PROVIDER_500_RECOVER}.`);
  assert(state.scenarioAttempts.PROVIDER_408_RECOVER === 3,
    `Expected three 408 attempts, received ${state.scenarioAttempts.PROVIDER_408_RECOVER}.`);
  assert(state.scenarioAttempts.PROVIDER_STALL_ONCE === 2,
    `Expected two timeout attempts, received ${state.scenarioAttempts.PROVIDER_STALL_ONCE}.`);
  assert(state.scenarioAttempts.PROVIDER_STREAM_INTERRUPT_ONCE === 2,
    `Expected two interrupted-stream attempts, received ${state.scenarioAttempts.PROVIDER_STREAM_INTERRUPT_ONCE}.`);
  assert(state.scenarioAttempts.PROVIDER_STALL_THREE === 3,
    `Expected the three-attempt timeout budget to be exhausted, received ${state.scenarioAttempts.PROVIDER_STALL_THREE}.`);

  console.log(JSON.stringify({
    automaticRecovery: {
      rateLimitAttempts: state.scenarioAttempts.PROVIDER_429_RECOVER,
      temporaryNotFoundAttempts: state.scenarioAttempts.PROVIDER_404_RECOVER,
      exhaustedTemporaryNotFoundAttempts: state.scenarioAttempts.PROVIDER_404_THREE,
      requestTimeoutAttempts: state.scenarioAttempts.PROVIDER_408_RECOVER,
      serverErrorAttempts: state.scenarioAttempts.PROVIDER_500_RECOVER,
      streamInterruptionAttempts: state.scenarioAttempts.PROVIDER_STREAM_INTERRUPT_ONCE,
      timeoutAttempts: state.scenarioAttempts.PROVIDER_STALL_ONCE,
    },
    sandboxLifecycle: { permitReuse: true, sequentialSessions: 2 },
    ok: true,
    recoverableFailures: ["provider-timeout-retry-budget-exhausted"],
    sameSessionContinuation: true,
  }));
} catch (error) {
  for (const [name, output] of childLogs) console.error(`\n[${name} tail]\n${output.slice(-8_000)}`);
  throw error;
} finally {
  await Promise.all(children.map(stopChild));
  await removeSyntheticSandboxContainers();
  await rm(isolatedAppRoot, { force: true, recursive: true });
}

async function completedTurn(host, message) {
  const { events } = await createAndConsume(host, message);
  assertCompleted(events, message);
  return events;
}

async function createAndConsume(host, message) {
  const { response, session } = await new Client({ host }).sessions.create({ message });
  syntheticSessionIds.add(response.sessionId);
  return { events: await collect(response), session };
}

async function removeSyntheticSandboxContainers() {
  const docker = process.env.EVE_DOCKER_PATH?.trim() || "docker";
  for (const sessionId of syntheticSessionIds) {
    if (!/^wrun_[A-Za-z0-9_-]+$/u.test(sessionId)) continue;
    try {
      const { stdout } = await execFileAsync(docker, [
        "ps", "-aq", "--filter", "label=eve.sandbox=1",
        "--filter", `label=eve.sandbox.tag.sessionId=${sessionId}`,
      ]);
      const containerIds = stdout.split(/\s+/u).filter(Boolean);
      if (containerIds.length > 0) await execFileAsync(docker, ["rm", "-f", ...containerIds]);
    } catch {
      // Verification cleanup is best effort and is scoped to synthetic IDs.
    }
  }
}

async function consume(session, message) {
  return collect(await session.send(message));
}

async function collect(response) {
  const events = [];
  for await (const event of response) events.push(event);
  return events;
}

function assertCompleted(events, label) {
  assert(events.some((event) => event.type === "turn.completed"), `${label} did not complete.`);
  assert(events.some((event) => event.type === "session.waiting"), `${label} did not preserve continuation.`);
  assert(!events.some((event) => event.type === "turn.failed"), `${label} emitted turn.failed.`);
}

function assertRecoverableFailure(events, label) {
  assert(events.some((event) => event.type === "step.failed"), `${label} did not emit step.failed.`);
  assert(events.some((event) => event.type === "turn.failed"), `${label} did not emit turn.failed.`);
  assert(events.some((event) => event.type === "session.waiting"), `${label} did not preserve the session.`);
  assert(!events.some((event) => event.type === "session.failed"), `${label} terminally failed the session.`);
}

function messageText(events) {
  return events
    .filter((event) => event.type === "message.appended")
    .map((event) => event.data.messageDelta)
    .join("");
}

function completedMessageText(events) {
  return events
    .filter((event) => event.type === "message.completed" && event.data.finishReason !== "tool-calls")
    .at(-1)?.data.message;
}

function spawnLogged(name, command, args, environment, cwd = projectRoot) {
  const child = spawn(command, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  childLogs.set(name, "");
  const record = (chunk) => childLogs.set(name, `${childLogs.get(name)}${chunk}`.slice(-50_000));
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  return child;
}

async function createIsolatedAppRoot(sourceRoot) {
  const target = await mkdtemp(join(tmpdir(), "open-agent-provider-failures-"));
  // The contracts package lives under packages/agent-contracts in the
  // workspace. Keep this isolated fixture aligned with the repository layout
  // instead of silently depending on a removed top-level contracts folder.
  for (const directory of ["agent", "evals", "lib", "packages", "server"]) {
    await cp(resolve(sourceRoot, directory), join(target, directory), {
      dereference: true,
      recursive: true,
    });
  }
  await symlink(resolve(sourceRoot, "node_modules"), join(target, "node_modules"), "dir");
  for (const file of ["instrumentation.ts", "package.json", "tsconfig.json"]) {
    await copyFile(resolve(sourceRoot, file), join(target, file));
  }
  return target;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
  }
}

async function waitFor(url, timeoutMs = 20_000) {
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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Could not reserve a verification port."));
        else resolvePort(port);
      });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
