import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

import { selectWorkflowRetentionCandidates } from "../lib/workflow-retention.ts";

const { Pool } = pg;
const connectionString = process.env.WORKFLOW_POSTGRES_URL?.trim();
if (!connectionString) throw new Error("WORKFLOW_POSTGRES_URL is required.");

const schemaName = process.env.WORKFLOW_POSTGRES_SCHEMA?.trim() || "workflow";
const schema = identifier(schemaName);
const maxRoots = boundedInteger(
  "WORKFLOW_RETENTION_MAX_ROOTS",
  optionalInteger("WORKFLOW_RETENTION_MAX_RUNS") ?? 100,
  1,
  10_000,
);
const olderThanMs = boundedInteger(
  "WORKFLOW_RETENTION_OLDER_THAN_MS",
  7 * 24 * 60 * 60 * 1_000,
  60_000,
  87_600 * 60 * 60 * 1_000,
);
const scanLimit = boundedInteger("WORKFLOW_RETENTION_SCAN_LIMIT", 10_000, 1, 100_000);
const topRootLimit = boundedInteger("WORKFLOW_RETENTION_TOP_ROOTS", 25, 1, 1_000);

// A Workflow root remains replay state even after a turn is terminal. This
// operator intentionally cannot purge it until Open Agent has a tested cold
// archive/restore adapter. A database backup is necessary operationally, but
// is not proof that one archived session can be restored into the product.
if (process.env.WORKFLOW_RETENTION_APPLY === "1" || process.env.WORKFLOW_RETENTION_CONFIRM?.trim()) {
  throw new Error(
    "Destructive Workflow cleanup is disabled. Archive complete root trees with a tested restore path before removing hot Workflow rows.",
  );
}

const pool = new Pool({
  application_name: "open-agent-workflow-retention-audit",
  connectionString,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  max: 2,
});
const now = new Date();
try {
  const runs = await loadRootTrees(pool, schema, scanLimit, now, olderThanMs);
  const protectedRunIds = await loadProtectedRuns(pool, schema, now);
  const selection = selectWorkflowRetentionCandidates(runs, now, {
    maxRuns: maxRoots,
    olderThanMs,
    protectedRunIds,
  });
  const candidateRunIds = selection.candidates.map((run) => run.id);
  const candidateSizes = candidateRunIds.length === 0
    ? new Map()
    : await loadRunPayloadSizes(pool, schema, candidateRunIds);
  const candidateRoots = groupCandidateRoots(selection.candidates, candidateSizes);
  const storage = await loadStorageAudit(pool, schemaName, schema, topRootLimit);
  const candidateBytes = candidateRoots.reduce((total, root) => total + root.payloadBytes, 0);

  const evidence = {
    schemaVersion: "open-agent.workflow-retention-evidence.v2",
    generatedAt: now.toISOString(),
    mode: "audit",
    configuration: { maxRoots, olderThanMs, scanLimit, schema: schemaName, topRootLimit },
    lifecycle: {
      destructiveOperationsEnabled: false,
      hotStore: "PostgreSQL Workflow World",
      archiveRequirement: "Archive the complete root tree, verify its checksum, and pass a restore drill before any external purge process is authorized.",
      historyPolicy: "No event-count, payload-size, or conversation-length limit is applied to user history.",
    },
    metrics: {
      scannedRootMembers: runs.length,
      protectedRoots: protectedRunIds.size,
      candidateRoots: candidateRoots.length,
      candidateRuns: candidateRunIds.length,
      candidatePayloadBytes: candidateBytes,
      skippedActiveRoots: selection.skippedActiveRoots,
      skippedProtectedRoots: selection.skippedProtected,
      deletedRuns: 0,
    },
    candidates: candidateRoots,
    storage,
    cutoff: selection.cutoff.toISOString(),
    safe: true,
  };
  await writeEvidence(evidence);
  console.log(JSON.stringify(evidence));
} finally {
  await pool.end();
}

async function loadRootTrees(pool, schema, limit, now, olderThanMs) {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const seeds = await pool.query(
    `select distinct coalesce(attributes->>'$rootRunId', id) as root_run_id
       from ${schema}.workflow_runs
      where status::text in ('completed', 'failed', 'cancelled')
        and completed_at <= $1
      order by coalesce(attributes->>'$rootRunId', id) asc
      limit $2`,
    [cutoff, limit],
  );
  const rootIds = seeds.rows.map((row) => String(row.root_run_id));
  if (rootIds.length === 0) return [];
  const result = await pool.query(
    `select id,
            status::text as status,
            coalesce(attributes->>'$rootRunId', id) as root_run_id,
            completed_at
       from ${schema}.workflow_runs
      where id = any($1::varchar[])
         or attributes->>'$rootRunId' = any($1::varchar[])
      order by coalesce(attributes->>'$rootRunId', id) asc, created_at asc, id asc`,
    [rootIds],
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

async function loadRunPayloadSizes(pool, schema, ids) {
  const result = await pool.query(
    `select run_id, coalesce(sum(bytes), 0)::bigint as bytes
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

function groupCandidateRoots(runs, sizes) {
  const roots = new Map();
  for (const run of runs) {
    const root = roots.get(run.rootRunId) ?? {
      rootRunId: run.rootRunId,
      completedAt: null,
      payloadBytes: 0,
      runIds: [],
      statuses: {},
    };
    root.runIds.push(run.id);
    root.payloadBytes += sizes.get(run.id) ?? 0;
    root.statuses[run.status] = (root.statuses[run.status] ?? 0) + 1;
    if (run.completedAt && (!root.completedAt || run.completedAt > root.completedAt)) {
      root.completedAt = run.completedAt;
    }
    roots.set(run.rootRunId, root);
  }
  return [...roots.values()].map((root) => ({
    ...root,
    completedAt: root.completedAt?.toISOString() ?? null,
  }));
}

async function loadStorageAudit(pool, schemaName, schema, topRootLimit) {
  const [relations, streamSummary, topRoots, statusCounts] = await Promise.all([
    pool.query(
      `select c.relname as table_name,
              pg_total_relation_size(c.oid)::bigint as total_bytes,
              pg_relation_size(c.oid)::bigint as heap_bytes,
              pg_indexes_size(c.oid)::bigint as index_bytes,
              coalesce(s.n_live_tup, 0)::bigint as estimated_rows
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_stat_user_tables s on s.relid = c.oid
        where n.nspname = $1 and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc`,
      [schemaName],
    ),
    pool.query(
      `select count(*)::bigint as chunk_count,
              count(distinct run_id)::bigint as run_count,
              count(distinct stream_id)::bigint as stream_count,
              coalesce(sum(octet_length(data)), 0)::bigint as payload_bytes,
              coalesce(max(octet_length(data)), 0)::bigint as max_chunk_bytes,
              coalesce(percentile_disc(0.50) within group (order by octet_length(data)), 0)::bigint as p50_chunk_bytes,
              coalesce(percentile_disc(0.95) within group (order by octet_length(data)), 0)::bigint as p95_chunk_bytes,
              coalesce(percentile_disc(0.99) within group (order by octet_length(data)), 0)::bigint as p99_chunk_bytes
         from ${schema}.workflow_stream_chunks`,
    ),
    pool.query(
      `with run_roots as (
         select id, status::text as status, coalesce(attributes->>'$rootRunId', id) as root_run_id
           from ${schema}.workflow_runs
       ), stream_payload as (
         select run_id, count(*)::bigint as chunks, sum(octet_length(data))::bigint as payload_bytes
           from ${schema}.workflow_stream_chunks
          group by run_id
       )
       select rr.root_run_id,
              count(*)::bigint as run_count,
              coalesce(sum(sp.chunks), 0)::bigint as chunk_count,
              coalesce(sum(sp.payload_bytes), 0)::bigint as payload_bytes,
              bool_or(rr.status not in ('completed', 'failed', 'cancelled')) as active
         from run_roots rr
         left join stream_payload sp on sp.run_id = rr.id
        group by rr.root_run_id
        order by coalesce(sum(sp.payload_bytes), 0) desc, rr.root_run_id asc
        limit $1`,
      [topRootLimit],
    ),
    pool.query(
      `select status::text as status, count(*)::bigint as count
         from ${schema}.workflow_runs
        group by status
        order by status`,
    ),
  ]);
  const relationRows = relations.rows.map((row) => ({
    table: String(row.table_name),
    totalBytes: Number(row.total_bytes),
    heapBytes: Number(row.heap_bytes),
    indexBytes: Number(row.index_bytes),
    estimatedRows: Number(row.estimated_rows),
  }));
  const stream = streamSummary.rows[0] ?? {};
  return {
    relationBytes: relationRows.reduce((total, row) => total + row.totalBytes, 0),
    relations: relationRows,
    runStatuses: Object.fromEntries(statusCounts.rows.map((row) => [String(row.status), Number(row.count)])),
    streamChunks: {
      chunkCount: Number(stream.chunk_count ?? 0),
      runCount: Number(stream.run_count ?? 0),
      streamCount: Number(stream.stream_count ?? 0),
      payloadBytes: Number(stream.payload_bytes ?? 0),
      maxChunkBytes: Number(stream.max_chunk_bytes ?? 0),
      p50ChunkBytes: Number(stream.p50_chunk_bytes ?? 0),
      p95ChunkBytes: Number(stream.p95_chunk_bytes ?? 0),
      p99ChunkBytes: Number(stream.p99_chunk_bytes ?? 0),
    },
    largestRoots: topRoots.rows.map((row) => ({
      rootRunId: String(row.root_run_id),
      runCount: Number(row.run_count),
      chunkCount: Number(row.chunk_count),
      payloadBytes: Number(row.payload_bytes),
      active: Boolean(row.active),
    })),
  };
}

async function writeEvidence(value) {
  const configured = process.env.WORKFLOW_RETENTION_EVIDENCE_PATH?.trim();
  if (!configured) return;
  const path = resolve(configured);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function optionalInteger(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`);
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

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error("WORKFLOW_POSTGRES_SCHEMA is invalid.");
  return `"${value}"`;
}
