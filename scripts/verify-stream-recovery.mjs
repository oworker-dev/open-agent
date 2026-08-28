import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

import { Client } from "eve/client";

import {
  compareRecoveredEventSequence,
  eventId,
} from "./lib/stream-recovery-verification.mjs";

const baseUrl = (process.env.AGENT_STREAM_RECOVERY_BASE_URL?.trim() || "http://127.0.0.1:3100")
  .replace(/\/+$/u, "");
const disconnectHoldMs = boundedInteger("AGENT_STREAM_RECOVERY_DISCONNECT_MS", 500, 50, 10_000);
const deadlineMs = boundedInteger("AGENT_STREAM_RECOVERY_DEADLINE_MS", 180_000, 10_000, 600_000);
const evidencePath = resolve(
  process.env.AGENT_STREAM_RECOVERY_EVIDENCE_PATH?.trim()
    || ".tmp/stream-recovery-evidence.json",
);
const batchId = `stream-recovery-${Date.now()}-${randomUUID()}`;
const marker = `STREAM_RECOVERY_READY_${randomUUID().replaceAll("-", "")}`;
const tenantId = `stream-recovery-tenant-${randomUUID()}`;
const principalId = `stream-recovery-user-${randomUUID()}`;
const runId = `arun_${randomUUID().replaceAll("-", "")}`;
const correlationId = `stream-recovery-${randomUUID()}`;
const token = signToken({
  actorType: "service",
  scope: ["agent:sessions"],
  sub: principalId,
  tenantId,
});
const requestHeaders = {
  "x-agent-correlation-id": correlationId,
  "x-agent-execution-mode": "automation",
  "x-agent-run-id": runId,
};
const client = new Client({
  auth: { bearer: token },
  headers: requestHeaders,
  host: baseUrl,
  redirect: "error",
});
const overallController = new AbortController();
const overallTimer = setTimeout(
  () => overallController.abort(new Error(`Stream recovery gate exceeded ${deadlineMs}ms.`)),
  deadlineMs,
);
overallTimer.unref?.();
let interruptedBy;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedBy = signal;
    overallController.abort(new Error(`Stream recovery gate received ${signal}.`));
  });
}

const evidence = {
  schemaVersion: "open-agent.stream-recovery-evidence.v1",
  batchId,
  generatedAt: new Date().toISOString(),
  targetOrigin: new URL(baseUrl).origin,
  configuration: { deadlineMs, disconnectHoldMs },
  metrics: {},
  cleanup: { attempted: false },
  violations: [],
  ok: false,
};
let session;
let failure;
const startedAt = performance.now();

try {
  const created = await client.sessions.create({
    message: [
      "This is an automated transport recovery check.",
      "Use the bash tool exactly once to run the following command:",
      `sleep 3; printf '${marker}\\n'`,
      `After the command completes, reply exactly: ${marker}`,
      "Do not perform any other action.",
    ].join("\n"),
    signal: overallController.signal,
    streamReconnectPolicy: { reconnect: false },
  });
  session = created.session;
  const sessionId = created.response.sessionId;
  assert(sessionId, "The synthetic session did not return a stable session id.");
  evidence.metrics.sessionFingerprint = fingerprint(sessionId);

  const first = await readEventStream({
    signal: overallController.signal,
    startIndex: 0,
    stopWhen: ({ event }) => event.type === "step.started",
  });
  assertReadSucceeded(first, "initial stream");
  assert(first.stopped, "The initial stream did not reach a live model-step boundary.");
  assert(!containsTerminal(first.events), "The synthetic task settled before the first disconnect.");

  const firstDisconnectAt = new Date().toISOString();
  const second = await readEventStream({
    abortAfterHeadersMs: disconnectHoldMs,
    signal: overallController.signal,
    startIndex: first.cursor,
  });
  assertReadSucceeded(second, "forced-disconnect stream");
  assert(second.opened, "The forced-disconnect stream did not reach the production gateway.");
  assert(second.intentionalAbort, "The forced-disconnect stream ended before the client aborted it.");

  const observedBeforeRecovery = [...first.events, ...second.events];
  assert(
    !containsTerminal(observedBeforeRecovery),
    "The synthetic task reached a terminal boundary before the forced active disconnect.",
  );
  const secondDisconnectAt = new Date().toISOString();

  const recovered = await recoverToStableBoundary({
    signal: overallController.signal,
    startIndex: second.cursor,
  });
  const observedEvents = [...observedBeforeRecovery, ...recovered.events];
  const boundary = observedEvents.findLast(isSessionBoundary);
  assert(boundary?.type === "session.waiting", `Recovered session ended at ${boundary?.type ?? "no boundary"}.`);
  assert(observedEvents.some((event) => event.type === "turn.completed"), "The recovered turn did not complete.");
  assert(observedEvents.some((event) => event.type === "actions.requested"), "The recovery task never requested its required tool.");
  assert(observedEvents.some((event) => event.type === "action.result"), "The recovery task never completed its required tool.");
  assert(
    observedEvents.some((event) => event.type === "message.completed" && event.data?.message === marker),
    "The recovered task did not deliver the exact marker.",
  );

  const canonical = await readCanonicalReplay({ signal: overallController.signal });
  const comparison = compareRecoveredEventSequence(observedEvents, canonical.events);
  evidence.violations.push(...comparison.violations);
  evidence.metrics = {
    ...evidence.metrics,
    canonicalEventCount: comparison.canonicalEventCount,
    canonicalTailIndex: canonical.tailIndex,
    disconnects: [
      { at: firstDisconnectAt, cursor: first.cursor, kind: "after-step-start" },
      { at: secondDisconnectAt, cursor: second.cursor, kind: "active-socket-abort" },
    ],
    firstConnectionEvents: first.events.length,
    forcedDisconnectEvents: second.events.length,
    recoveredEvents: recovered.events.length,
    reconnectAttempts: recovered.attempts,
    finalCursor: recovered.cursor,
    observedEventCount: comparison.observedEventCount,
    stableEventIdFingerprint: fingerprint(canonical.events.map(eventId).join("\0")),
    stableEventIdSequenceMatch: comparison.stableIdSequenceMatch,
    taskContinuedAfterDisconnect: true,
  };
  assert(comparison.stableIdSequenceMatch, comparison.violations.join(" "));
} catch (error) {
  failure = error;
  evidence.violations.push(safeError(error));
} finally {
  clearTimeout(overallTimer);
  evidence.cleanup = await cleanupSyntheticSession(session);
  if (evidence.cleanup.attempted && !evidence.cleanup.authorizedReset) {
    evidence.violations.push("The synthetic Eve session was not retired through its authorized reset lifecycle.");
  }
  if (interruptedBy) evidence.violations.push(`The gate was interrupted by ${interruptedBy}.`);
  evidence.completedAt = new Date().toISOString();
  evidence.durationMs = Math.round(performance.now() - startedAt);
  evidence.ok = evidence.violations.length === 0;
  await writeEvidence(evidence);
  console.log(JSON.stringify(evidence));
}

if (!evidence.ok) {
  process.exitCode = 1;
  if (failure) console.error(safeError(failure));
}

async function readEventStream(options) {
  const transportController = new AbortController();
  const signal = AbortSignal.any([options.signal, transportController.signal]);
  const events = [];
  let cursor = options.startIndex;
  let intentionalAbort = false;
  let opened = false;
  let reader;
  let abortTimer;
  let stopped = false;
  let tailIndex;
  try {
    const url = streamUrl(options.startIndex, options.includeTailIndex === true);
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/x-ndjson",
        authorization: `Bearer ${token}`,
        ...requestHeaders,
      },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw httpError(response.status);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("ndjson")) {
      throw new Error(`Stream recovery endpoint returned ${contentType || "no content type"}.`);
    }
    opened = true;
    if (options.includeTailIndex === true) {
      tailIndex = Number(response.headers.get("x-eve-stream-tail-index"));
      if (!Number.isSafeInteger(tailIndex) || tailIndex < options.startIndex - 1) {
        throw new Error("Finite canonical replay did not return a valid absolute tail index.");
      }
      if (tailIndex < options.startIndex) {
        stopped = true;
        return { cursor, events, intentionalAbort, opened, stopped, tailIndex };
      }
    }
    if (!response.body) throw new Error("Stream recovery endpoint returned no response body.");
    reader = response.body.getReader();
    if (options.abortAfterHeadersMs !== undefined) {
      abortTimer = setTimeout(() => {
        intentionalAbort = true;
        transportController.abort(new Error("intentional stream recovery disconnect"));
      }, options.abortAfterHeadersMs);
      abortTimer.unref?.();
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const event = parseEvent(buffer);
          events.push(event);
          cursor += 1;
        }
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseEvent(line);
        events.push(event);
        cursor += 1;
        if (
          options.stopWhen?.({ cursor, event, tailIndex })
          || (tailIndex !== undefined && cursor > tailIndex)
        ) {
          stopped = true;
          return { cursor, events, intentionalAbort, opened, stopped, tailIndex };
        }
      }
    }
    return { cursor, events, intentionalAbort, opened, stopped, tailIndex };
  } catch (error) {
    if (intentionalAbort && !options.signal.aborted) {
      return { cursor, events, intentionalAbort: true, opened, stopped, tailIndex };
    }
    return { cursor, error, events, intentionalAbort, opened, stopped, tailIndex };
  } finally {
    clearTimeout(abortTimer);
    await reader?.cancel().catch(() => undefined);
    transportController.abort();
  }
}

async function recoverToStableBoundary(options) {
  const events = [];
  let cursor = options.startIndex;
  let attempts = 0;
  let delayMs = 100;
  while (!options.signal.aborted && attempts < 8) {
    attempts += 1;
    const page = await readEventStream({
      signal: options.signal,
      startIndex: cursor,
      stopWhen: ({ event }) => isSessionBoundary(event),
    });
    events.push(...page.events);
    cursor = page.cursor;
    if (page.events.some(isSessionBoundary)) return { attempts, cursor, events };
    if (page.error && !isRetryableStreamError(page.error)) throw page.error;
    await delayWithSignal(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, 2_000);
  }
  if (options.signal.aborted) throw options.signal.reason;
  throw new Error("Stream recovery did not reach a stable session boundary after 8 reconnects.");
}

async function readCanonicalReplay(options) {
  const events = [];
  let cursor = 0;
  let tailIndex;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const page = await readEventStream({
      includeTailIndex: true,
      signal: options.signal,
      startIndex: cursor,
    });
    events.push(...page.events);
    cursor = page.cursor;
    tailIndex = page.tailIndex ?? tailIndex;
    if (tailIndex !== undefined && cursor > tailIndex) return { cursor, events, tailIndex };
    if (page.error && !isRetryableStreamError(page.error)) throw page.error;
    await delayWithSignal(Math.min(1_000, attempt * 100), options.signal);
  }
  throw new Error("Finite canonical replay did not reach its declared durable tail after 8 reconnects.");
}

async function cleanupSyntheticSession(activeSession) {
  if (!activeSession) return { attempted: false, authorizedReset: false, sandboxContainersRemoved: 0 };
  const cleanup = { attempted: true, authorizedReset: false, sandboxContainersRemoved: 0 };
  try {
    const sessionId = activeSession.state.sessionId;
    const result = await activeSession.reset();
    cleanup.resetStatus = result.status;
    cleanup.authorizedReset = result.status === "reset" || result.status === "no_active_session";
    if (cleanup.authorizedReset && sessionId) {
      cleanup.sandboxContainersRemoved = await removeOwnedTestSandboxes(sessionId);
    }
  } catch (error) {
    cleanup.error = safeError(error);
  }
  return cleanup;
}

async function removeOwnedTestSandboxes(sessionId) {
  if (!/^wrun_[A-Za-z0-9_-]+$/u.test(sessionId)) return 0;
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(
      process.env.EVE_DOCKER_PATH?.trim() || "docker",
      ["ps", "-aq", "--filter", "label=eve.sandbox=1", "--filter", `label=eve.sandbox.tag.sessionId=${sessionId}`],
      { maxBuffer: 64 * 1024 },
    );
    const ids = stdout.split(/\s+/u).filter(Boolean);
    if (ids.length === 0) return 0;
    await execFileAsync(
      process.env.EVE_DOCKER_PATH?.trim() || "docker",
      ["rm", "-f", ...ids],
      { maxBuffer: 64 * 1024 },
    );
    return ids.length;
  } catch {
    // Reset is the authoritative lifecycle. Docker cleanup applies only to the
    // local backend and is deliberately scoped to this synthetic session label.
    return 0;
  }
}

function streamUrl(startIndex, includeTailIndex) {
  assert(session?.state.sessionId, "A session id is required before opening its stream.");
  const url = new URL(
    `/eve/v1/session/${encodeURIComponent(session.state.sessionId)}/stream`,
    `${baseUrl}/`,
  );
  url.searchParams.set("startIndex", String(startIndex));
  if (includeTailIndex) {
    url.searchParams.set("follow", "0");
    url.searchParams.set("includeTailIndex", "1");
  }
  return url;
}

function parseEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new Error("Stream recovery endpoint returned invalid NDJSON.");
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw new Error("Stream recovery endpoint returned an invalid event envelope.");
  }
  return event;
}

function containsTerminal(events) {
  return events.some((event) => isSessionBoundary(event) || [
    "turn.cancelled",
    "turn.completed",
    "turn.failed",
  ].includes(event.type));
}

function isSessionBoundary(event) {
  return ["session.completed", "session.failed", "session.waiting"].includes(event.type);
}

function assertReadSucceeded(read, label) {
  if (read.error) throw new Error(`${label} failed: ${safeError(read.error)}`);
}

function isRetryableStreamError(error) {
  const status = error && typeof error === "object" ? Reflect.get(error, "status") : undefined;
  if (typeof status === "number") {
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
  }
  return error instanceof TypeError
    || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

function httpError(status) {
  const error = new Error(`Stream recovery endpoint returned HTTP ${status}.`);
  error.status = status;
  return error;
}

function signToken(claims) {
  const secret = required("AGENT_HOST_JWT_SECRET");
  const issuer = required("AGENT_HOST_JWT_ISSUER");
  const audience = required("AGENT_HOST_JWT_AUDIENCE");
  const now = Math.floor(Date.now() / 1_000);
  const header = encodeJwt({ alg: "HS256", typ: "JWT" });
  const payload = encodeJwt({
    ...claims,
    aud: audience,
    exp: now + Math.max(300, Math.ceil(deadlineMs / 1_000) + 120),
    iat: now,
    iss: issuer,
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function encodeJwt(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function delayWithSignal(milliseconds, signal) {
  await new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) return rejectPromise(signal.reason);
    const timer = setTimeout(resolvePromise, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
}

async function writeEvidence(value) {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replaceAll(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}
