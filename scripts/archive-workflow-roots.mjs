import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { once } from "node:events";
import pg from "pg";

import {
  createWorkflowArchiveAccumulator,
  createWorkflowArchiveHeader,
} from "../lib/workflow-archive.ts";

const TABLE_SPECS = [
  { name: "workflow_runs", runColumn: "id", order: ["id"], batchSize: 250 },
  { name: "workflow_steps", runColumn: "run_id", order: ["step_id"], batchSize: 500 },
  { name: "workflow_events", runColumn: "run_id", order: ["id"], batchSize: 500 },
  { name: "workflow_hooks", runColumn: "run_id", order: ["hook_id"], batchSize: 250 },
  { name: "workflow_waits", runColumn: "run_id", order: ["wait_id"], batchSize: 250 },
  { name: "workflow_stream_chunks", runColumn: "run_id", order: ["stream_id", "id"], batchSize: 500 },
  { name: "workflow_event_slots", runColumn: "run_id", order: ["run_id"], batchSize: 250 },
];

const { Pool } = pg;
const args = parseArgs(process.argv.slice(2));
const connectionString = process.env.WORKFLOW_POSTGRES_URL?.trim();
if (!connectionString) throw new Error("WORKFLOW_POSTGRES_URL is required.");
const sourceSchema = validateIdentifier(args.schema || process.env.WORKFLOW_POSTGRES_SCHEMA?.trim() || "workflow", "schema");
const rootRunIds = (args.rootIds || process.env.WORKFLOW_ARCHIVE_ROOT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (rootRunIds.length === 0) throw new Error("Provide --root-run-id or WORKFLOW_ARCHIVE_ROOT_IDS.");
if (rootRunIds.some((value) => value.length > 512 || /\s/u.test(value))) {
  throw new Error("Root run ids must be non-empty identifiers without whitespace.");
}
const output = resolve(args.output || process.env.WORKFLOW_ARCHIVE_OUTPUT || "");
if (!args.output && !process.env.WORKFLOW_ARCHIVE_OUTPUT?.trim()) {
  throw new Error("Provide --output or WORKFLOW_ARCHIVE_OUTPUT.");
}
const queryTimeoutMs = boundedInteger(
  "WORKFLOW_POSTGRES_QUERY_TIMEOUT_MS",
  15_000,
  100,
  300_000,
);
await mkdir(dirname(output), { recursive: true });

const pool = new Pool({
  application_name: "open-agent-workflow-archive",
  connectionString,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  query_timeout: queryTimeoutMs,
  statement_timeout: queryTimeoutMs,
  max: 2,
});
const writer = createWriteStream(output, { flags: "wx", mode: 0o600 });
try {
  const runs = await loadRootTree(pool, sourceSchema, rootRunIds);
  if (runs.length === 0) throw new Error("No Workflow runs matched the requested root ids.");
  const discoveredRoots = new Set(runs.map((run) => run.rootRunId));
  const missingRoots = rootRunIds.filter((root) => !discoveredRoots.has(root));
  if (missingRoots.length > 0) {
    throw new Error(`Requested Workflow root was not found: ${missingRoots[0]}.`);
  }
  const active = runs.filter((run) => !["completed", "failed", "cancelled"].includes(run.status));
  if (active.length > 0) {
    throw new Error(`Refusing to archive an active Workflow root (${active[0].id}).`);
  }
  const runIds = runs.map((run) => run.id);
  const header = createWorkflowArchiveHeader({
    createdAt: new Date().toISOString(),
    rootRunIds,
    sourceSchema,
  });
  await writeLine(writer, JSON.stringify(header));
  const accumulator = createWorkflowArchiveAccumulator();
  for (const spec of TABLE_SPECS) {
    if (!(await tableExists(pool, sourceSchema, spec.name))) continue;
    await readTable(pool, sourceSchema, spec, runIds, async (row) => {
      await writeLine(writer, accumulator.add({ kind: "row", table: spec.name, row }));
    });
  }
  await writeLine(writer, JSON.stringify(accumulator.finish()));
  writer.end();
  await once(writer, "close");
  console.log(JSON.stringify({
    ok: true,
    output,
    format: header.format,
    sourceSchema,
    rootRunIds: header.rootRunIds,
    runCount: runs.length,
  }));
} finally {
  writer.destroy();
  await pool.end();
}

async function loadRootTree(pool, schema, roots) {
  const result = await pool.query(
    `select id, status::text as status,
            coalesce(attributes->>'$rootRunId', id) as root_run_id
       from ${quote(schema)}.workflow_runs
      where id = any($1::varchar[])
         or attributes->>'$rootRunId' = any($1::varchar[])
      order by coalesce(attributes->>'$rootRunId', id), created_at, id`,
    [roots],
  );
  return result.rows.map((row) => ({ id: String(row.id), status: String(row.status), rootRunId: String(row.root_run_id || row.id) }));
}

async function tableExists(pool, schema, table) {
  const result = await pool.query("select to_regclass($1) is not null as exists", [`${schema}.${table}`]);
  return result.rows[0]?.exists === true;
}

async function readTable(pool, schema, spec, runIds, onRow) {
  let cursor;
  while (true) {
    const values = [runIds];
    const conditions = [`${quote(spec.runColumn)} = any($1::varchar[])`];
    if (cursor) {
      if (spec.order.length === 1) {
        values.push(cursor[0]);
        conditions.push(`${quote(spec.order[0])} > $${values.length}`);
      } else {
        values.push(cursor[0], cursor[1]);
        conditions.push(`(${spec.order.map(quote).join(", ")}) > ($2, $3)`);
      }
    }
    values.push(spec.batchSize);
    const result = await pool.query(
      `select * from ${quote(schema)}.${quote(spec.name)}
        where ${conditions.join(" and ")}
        order by ${spec.order.map(quote).join(", ")}
        limit $${values.length}`,
      values,
    );
    if (result.rows.length === 0) return;
    for (const row of result.rows) await onRow(row);
    const last = result.rows.at(-1);
    cursor = spec.order.map((column) => last[column]);
    if (result.rows.length < spec.batchSize) return;
  }
}

async function writeLine(stream, value) {
  if (!stream.write(`${value}\n`)) await once(stream, "drain");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root-run-id") result.rootIds = `${result.rootIds ? `${result.rootIds},` : ""}${required(argv[++index], argument)}`;
    else if (argument === "--output") result.output = required(argv[++index], argument);
    else if (argument === "--schema") result.schema = required(argv[++index], argument);
    else if (argument === "--help") {
      console.log("Usage: WORKFLOW_POSTGRES_URL=... node scripts/archive-workflow-roots.mjs --root-run-id <id> --output <file> [--schema workflow]");
      process.exit(0);
    } else throw new Error(`Unknown argument ${argument}.`);
  }
  return result;
}

function required(value, name) {
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function validateIdentifier(value, name) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error(`${name} must be a valid PostgreSQL identifier.`);
  return value;
}

function quote(value) {
  return `"${value.replaceAll('"', '""')}"`;
}
