import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Client } from "eve/client";

const baseUrl = (process.env.AGENT_STREAM_LOAD_BASE_URL?.trim() || "http://127.0.0.1:3100").replace(/\/$/, "");
const totalStreams = boundedInteger("AGENT_STREAM_LOAD_TOTAL", 100, 1, 10_000);
const concurrency = boundedInteger("AGENT_STREAM_LOAD_CONCURRENCY", Math.min(totalStreams, 100), 1, 1_000);
const holdMs = boundedInteger("AGENT_STREAM_LOAD_HOLD_MS", 5_000, 1_000, 300_000);
const handshakeDeadlineMs = boundedInteger("AGENT_STREAM_LOAD_HANDSHAKE_DEADLINE_MS", 30_000, 1_000, 300_000);
const maxErrorRate = boundedNumber("AGENT_STREAM_LOAD_MAX_ERROR_RATE", 0, 0, 1);
const p95HandshakeMs = boundedInteger("AGENT_STREAM_LOAD_P95_HANDSHAKE_MS", 5_000, 10, 300_000);
const batchId = `stream-load-${Date.now()}-${randomUUID()}`;
const principalId = `stream-load-runner-${randomUUID()}`;
const accessToken = signToken({
  actorType: "service",
  scope: ["agent:sessions"],
  sub: principalId,
  tenantId: `stream-load-tenant-${randomUUID()}`,
});
const client = new Client({
  auth: { bearer: accessToken },
  host: baseUrl,
  redirect: "error",
});

const marker = `STREAM_LOAD_READY_${batchId}`;
const seed = await client.sessions.create({
  message: `Do not use tools. Reply exactly: ${marker}`,
});
const seedEvents = [];
for await (const event of seed.response) seedEvents.push(event);
const session = seed.session;
const sessionId = session.state.sessionId;
const streamIndex = session.state.streamIndex;
assert(sessionId, "The seed turn did not return a durable session id.");
assert(streamIndex > 0, "The seed turn did not advance the durable stream cursor.");
assert(
  seedEvents.some((event) => event.type === "session.waiting" || event.type === "session.completed"),
  "The seed session did not reach a stable stream boundary.",
);

const memory = createMemorySampler();
const startedAt = performance.now();
const attempts = await mapWithConcurrency(
  Array.from({ length: totalStreams }, (_, index) => index),
  concurrency,
  async (index) => await openFollower(index),
);
const establishedAt = performance.now();
const established = attempts.filter((entry) => entry.ok);
const failures = attempts.filter((entry) => !entry.ok);

await delay(holdMs);
const liveness = await Promise.all(established.map(async (entry) => ({
  index: entry.index,
  alive: await followerIsOpen(entry.reader),
})));
const unexpectedDisconnects = liveness.filter((entry) => !entry.alive);

for (const entry of established) entry.controller.abort("stream-load-complete");
await Promise.allSettled(established.map((entry) => entry.reader.cancel().catch(() => undefined)));
memory.stop();
await session.reset({ reason: `idle-stream-load:${batchId}` }).catch(() => undefined);

const handshake = summarize(established.map((entry) => entry.handshakeMs));
const errorRate = failures.length / totalStreams;
const violations = [];
if (errorRate > maxErrorRate) violations.push(`Stream error rate ${round(errorRate, 4)} exceeded ${maxErrorRate}.`);
if ((handshake.p95Ms ?? Number.POSITIVE_INFINITY) > p95HandshakeMs) {
  violations.push(`p95 stream handshake ${handshake.p95Ms} ms exceeded ${p95HandshakeMs} ms.`);
}
if (unexpectedDisconnects.length > 0) {
  violations.push(`${unexpectedDisconnects.length} established streams disconnected during the hold interval.`);
}

const evidence = {
  schemaVersion: "open-agent.idle-stream-load-evidence.v1",
  batchId,
  generatedAt: new Date().toISOString(),
  targetOrigin: new URL(baseUrl).origin,
  configuration: {
    concurrency,
    handshakeDeadlineMs,
    holdMs,
    totalStreams,
  },
  budgets: { maxErrorRate, p95HandshakeMs },
  metrics: {
    established: established.length,
    failures: failures.length,
    errorRate: round(errorRate, 4),
    unexpectedDisconnects: unexpectedDisconnects.length,
    establishmentDurationMs: Math.round(establishedAt - startedAt),
    handshake,
    processMemory: memory.result(),
  },
  failures: failures.map((entry) => ({ index: entry.index, error: entry.error })),
  violations,
  ok: violations.length === 0,
};

await writeEvidence(evidence);
console.log(JSON.stringify(evidence));
assert(evidence.ok, `Idle stream load gate failed: ${violations.join(" ")}`);

async function openFollower(index) {
  const controller = new AbortController();
  const handshakeController = new AbortController();
  const handshakeTimer = setTimeout(
    () => handshakeController.abort(new Error("stream handshake timed out")),
    handshakeDeadlineMs,
  );
  const signal = AbortSignal.any([controller.signal, handshakeController.signal]);
  const openedAt = performance.now();
  try {
    const path = `/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${Math.max(0, streamIndex - 1)}`;
    let delayMs = 250;
    let lastStatus;
    while (!signal.aborted) {
      const response = await fetch(new URL(path, `${baseUrl}/`), {
        cache: "no-store",
        headers: {
          accept: "application/x-ndjson",
          authorization: `Bearer ${accessToken}`,
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        lastStatus = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (![404, 409, 425, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`stream returned HTTP ${response.status}`);
        }
        await delayWithSignal(delayMs, signal);
        delayMs = Math.min(delayMs * 2, 5_000);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("ndjson")) {
        throw new Error(`stream returned unexpected content type ${contentType || "(missing)"}`);
      }
      if (!response.body) throw new Error("stream returned no response body");
      const reader = response.body.getReader();
      const first = await reader.read();
      if (first.done || !first.value?.byteLength) throw new Error("stream closed before the durable tail was received");
      clearTimeout(handshakeTimer);
      return {
        controller,
        handshakeMs: performance.now() - openedAt,
        index,
        ok: true,
        reader,
      };
    }
    throw new Error(`stream handshake timed out${lastStatus ? ` after HTTP ${lastStatus}` : ""}`);
  } catch (cause) {
    clearTimeout(handshakeTimer);
    controller.abort("stream-load-open-failed");
    return { error: safeError(cause), index, ok: false };
  }
}

async function followerIsOpen(reader) {
  const probe = reader.read().then(
    (value) => value.done ? "closed" : "data",
    () => "closed",
  );
  return await Promise.race([probe, delay(100).then(() => "open")]) !== "closed";
}

function createMemorySampler() {
  const initial = process.memoryUsage();
  let peakRss = initial.rss;
  let peakHeapUsed = initial.heapUsed;
  const timer = setInterval(() => {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    peakHeapUsed = Math.max(peakHeapUsed, current.heapUsed);
  }, 100);
  timer.unref();
  return {
    stop() { clearInterval(timer); },
    result() {
      const final = process.memoryUsage();
      return {
        initialRssBytes: initial.rss,
        finalRssBytes: final.rss,
        peakRssBytes: peakRss,
        initialHeapUsedBytes: initial.heapUsed,
        finalHeapUsedBytes: final.heapUsed,
        peakHeapUsedBytes: peakHeapUsed,
      };
    },
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(values) {
  if (values.length === 0) return { samples: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
  return {
    samples: sorted.length,
    minMs: Math.round(sorted[0]),
    maxMs: Math.round(sorted.at(-1)),
    meanMs: Math.round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    p50Ms: Math.round(percentile(0.5)),
    p95Ms: Math.round(percentile(0.95)),
    p99Ms: Math.round(percentile(0.99)),
  };
}

async function writeEvidence(value) {
  const configured = process.env.AGENT_STREAM_LOAD_EVIDENCE_PATH?.trim();
  if (!configured) return;
  const path = resolve(configured);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function signToken(claims) {
  const secret = required("AGENT_HOST_JWT_SECRET");
  const issuer = required("AGENT_HOST_JWT_ISSUER");
  const audience = required("AGENT_HOST_JWT_AUDIENCE");
  const now = Math.floor(Date.now() / 1_000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    ...claims,
    aud: audience,
    exp: now + Math.max(300, Math.ceil((handshakeDeadlineMs + holdMs) / 1_000) + 120),
    iat: now,
    iss: issuer,
    jti: randomUUID(),
  });
  const input = `${header}.${payload}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boundedNumber(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeError(cause) {
  return (cause instanceof Error ? cause.message : String(cause)).replaceAll(/[\r\n\t]+/gu, " ").slice(0, 500);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function delayWithSignal(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
