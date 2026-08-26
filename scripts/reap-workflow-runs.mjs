import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import {
  selectWorkflowRetentionCandidates,
} from "../lib/workflow-retention.ts";

const { Pool } = pg;
const connectionString = process.env.WORKFLOW_POSTGRES_URL?.trim();
if (!connectionString) throw new Error("WORKFLOW_POSTGRES_URL is required.");

const schema = identifier(process.env.WORKFLOW_POSTGRES_SCHEMA?.trim() || "workflow");
const maxRuns = boundedInteger("WORKFLOW_RETENTION_MAX_RUNS", 100, 1, 10_000);
const olderThanMs = boundedInteger(
  "WORKFLOW_RETENTION_OLDER_THAN_MS",
  7 * 24 * 60 * 60 * 1_000,
  60_000,
  87_600 * 60 * 60 * 1_000,
);
const scanLimit = boundedInteger("WORKFLOW_RETENTION_SCAN_LIMIT", 10_000, 1, 100_000);
const apply = process.env.WORKFLOW_RETENTION_APPLY === "1";
const confirmation = process.env.WORKFLOW_RETENTION_CONFIRM?.trim();
if (apply && confirmation !== "delete-workflow-runs") {
  throw new Error("WORKFLOW_RETENTION_CONFIRM=delete-workflow-runs is required when applying cleanup.");
}

const pool = new Pool({
  application_name: "open-agent-workflow-retention",
  connectionString,
  max: 2,
});
const now = new Date();
try {
  const runs = await loadRuns(pool, schema, scanLimit);
  const protectedRunIds = await loadProtectedRuns(pool, schema, now);
  const selection = selectWorkflowRetentionCandidates(runs, now, {
    maxRuns,
    olderThanMs,
    protectedRunIds,
  });
  const candidateIds = selection.candidates.map((run) => run.id);
  const sizes = candidateIds.length === 0
    ? new Map()
    : await loadCandidateSizes(pool, schema, candidateIds);
  const bytes = [...sizes.values()].reduce((total, value) => total + value, 0);
  let deletedRuns = 0;
  if (apply && candidateIds.length > 0) {
    deletedRuns = await deleteRuns(pool, schema, candidateIds, now, selection.cutoff);
  }

  const evidence = {
    schemaVersion: "open-agent.workflow-retention-evidence.v1",
    generatedAt: now.toISOString(),
    mode: apply ? "apply" : "dry-run",
    configuration: { maxRuns, olderThanMs, scanLimit, schema },
    metrics: {
      scannedRuns: runs.length,
      protectedRuns: protectedRunIds.size,
      candidates: candidateIds.length,
      candidateBytes: bytes,
      skippedActiveRoots: selection.skippedActiveRoots,
      skippedProtected: selection.skippedProtected,
      deletedRuns,
    },
    candidates: selection.candidates.map((run) => ({
      id: run.id,
      rootRunId: run.rootRunId,
      status: run.status,
      completedAt: run.completedAt?.toISOString() ?? null,
      bytes: sizes.get(run.id) ?? 0,
    })),
    cutoff: selection.cutoff.toISOString(),
    safe: !apply || deletedRuns <= candidateIds.length,
  };
  await writeEvidence(evidence);
  console.log(JSON.stringify(evidence));
} finally {
  await pool.end();
}

async function loadRuns(pool, schema, limit) {
  const result = await pool.query(
    `select
       id,
       status::text as status,
       coalesce(attributes->>'$rootRunId', id) as root_run_id,
       completed_at
       from ${schema}.workflow_runs
      where status::text in ('pending', 'running', 'completed', 'failed', 'cancelled')
      order by coalesce(completed_at, updated_at) asc, id asc
      limit $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    rootRunId: String(row.root_run_id || row.id),
    status: String(row.status),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  }));
}

async function loadProtectedRuns(pool, schema, now) {
  const result = await pool.query(
    `select distinct coalesce(r.attributes->>'$rootRunId', r.id) as root_run_id
       from ${schema}.workflow_hooks h
       join ${schema}.workflow_runs r on r.id = h.run_id
      where h.token_retention_until is null or h.token_retention_until > $1`,
    [now],
  );
  return new Set(result.rows.map((row) => String(row.root_run_id)));
}

async function loadCandidateSizes(pool, schema, ids) {
  const result = await pool.query(
    `select run_id,
            coalesce(sum(bytes), 0)::bigint as bytes
       from (
         select run_id, octet_length(data)::bigint as bytes
           from ${schema}.workflow_stream_chunks
          where run_id = any($1::varchar[])
         union all
         select run_id, octet_length(coalesce(payload_cbor, ''::bytea))::bigint as bytes
           from ${schema}.workflow_events
          where run_id = any($1::varchar[])
       ) payloads
      group by run_id`,
    [ids],
  );
  return new Map(result.rows.map((row) => [String(row.run_id), Number(row.bytes)]));
}

async function deleteRuns(pool, schema, ids, now, cutoff) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Re-check under row locks. The initial candidate scan is intentionally
    // outside this transaction for cheap dry-runs, so status, descendants, or
    // hook retention may change before apply mode reaches the delete phase.
    const locked = await client.query(
      `select id,
              status::text as status,
              coalesce(attributes->>'$rootRunId', id) as root_run_id,
              completed_at
         from ${schema}.workflow_runs
        where id = any($1::varchar[])
        for update`,
      [ids],
    );
    if (locked.rows.length === 0) {
      await client.query("commit");
      return 0;
    }
    const rootIds = [...new Set(locked.rows.map((row) => String(row.root_run_id || row.id)))];
    const rootRuns = await client.query(
      `select id,
              status::text as status,
              coalesce(attributes->>'$rootRunId', id) as root_run_id
         from ${schema}.workflow_runs
        where coalesce(attributes->>'$rootRunId', id) = any($1::varchar[])
        for update`,
      [rootIds],
    );
    const activeRoots = new Set(
      rootRuns.rows
        .filter((row) => !["completed", "failed", "cancelled"].includes(String(row.status)))
        .map((row) => String(row.root_run_id || row.id)),
    );
    const protectedRootsResult = await client.query(
      `select distinct coalesce(r.attributes->>'$rootRunId', r.id) as root_run_id
         from ${schema}.workflow_hooks h
         join ${schema}.workflow_runs r on r.id = h.run_id
        where coalesce(r.attributes->>'$rootRunId', r.id) = any($1::varchar[])
          and (h.token_retention_until is null or h.token_retention_until > $2)`,
      [rootIds, now],
    );
    const protectedRoots = new Set(
      protectedRootsResult.rows.map((row) => String(row.root_run_id)),
    );
    const eligibleIds = locked.rows
      .filter((row) => ["completed", "failed", "cancelled"].includes(String(row.status)))
      .filter((row) => row.completed_at && new Date(row.completed_at).getTime() <= cutoff.getTime())
      .filter((row) => {
        const rootId = String(row.root_run_id || row.id);
        return !activeRoots.has(rootId) && !protectedRoots.has(rootId);
      })
      .map((row) => String(row.id));
    if (eligibleIds.length === 0) {
      await client.query("commit");
      return 0;
    }
    await client.query(`delete from ${schema}.workflow_hooks where run_id = any($1::varchar[])`, [eligibleIds]);
    await client.query(`delete from ${schema}.workflow_stream_chunks where run_id = any($1::varchar[])`, [eligibleIds]);
    await client.query(`delete from ${schema}.workflow_events where run_id = any($1::varchar[])`, [eligibleIds]);
    await client.query(`delete from ${schema}.workflow_steps where run_id = any($1::varchar[])`, [eligibleIds]);
    await client.query(`delete from ${schema}.workflow_waits where run_id = any($1::varchar[])`, [eligibleIds]);
    await client.query(`delete from ${schema}.workflow_event_slots where run_id = any($1::varchar[])`, [eligibleIds]);
    const deleted = await client.query(
      `delete from ${schema}.workflow_runs where id = any($1::varchar[]) returning id`,
      [eligibleIds],
    );
    await client.query("commit");
    return deleted.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function writeEvidence(value) {
  const configured = process.env.WORKFLOW_RETENTION_EVIDENCE_PATH?.trim();
  if (!configured) return;
  const path = resolve(configured);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error("WORKFLOW_POSTGRES_SCHEMA is invalid.");
  return `"${value}"`;
}
