import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import pg from "pg";

import {
  createWorkflowArchiveValidator,
  decodeWorkflowArchiveLine,
  encodeWorkflowArchiveLine,
  WORKFLOW_ARCHIVE_TABLES,
} from "../lib/workflow-archive.ts";

/**
 * Validate an archive and, when explicitly requested, restore it into a
 * separately migrated Workflow World. The default is read-only. This command
 * never creates tables or purges rows: a target must already be an isolated
 * Workflow database prepared with the exact runtime version under test.
 */
const archivePath = process.argv[2] || process.env.WORKFLOW_ARCHIVE_INPUT?.trim();
if (!archivePath) throw new Error("Provide an archive path or WORKFLOW_ARCHIVE_INPUT.");
const execute = process.argv.includes("--execute");
if (execute && process.env.WORKFLOW_ARCHIVE_RESTORE_CONFIRM !== "1") {
  throw new Error("Refusing to write a Workflow World without WORKFLOW_ARCHIVE_RESTORE_CONFIRM=1.");
}
const targetUrl = process.env.WORKFLOW_ARCHIVE_RESTORE_URL?.trim();
const targetSchema = validateIdentifier(
  process.env.WORKFLOW_ARCHIVE_RESTORE_SCHEMA?.trim() || "workflow",
  "WORKFLOW_ARCHIVE_RESTORE_SCHEMA",
);
const maxRecords = boundedInteger(
  process.env.WORKFLOW_ARCHIVE_MAX_RECORDS,
  5_000_000,
  1,
  50_000_000,
);

const scanned = await scanArchive(archivePath, maxRecords);
if (!execute) {
  console.log(JSON.stringify({
    ok: true,
    mode: "validate",
    archivePath,
    ...scanned,
    note: "No database was changed. Use --execute with WORKFLOW_ARCHIVE_RESTORE_CONFIRM=1 and an isolated Workflow World URL to restore.",
  }));
} else {
  if (!targetUrl) throw new Error("WORKFLOW_ARCHIVE_RESTORE_URL is required with --execute.");
  const result = await restoreArchive(archivePath, targetUrl, targetSchema, scanned);
  console.log(JSON.stringify({ ok: true, mode: "restore", archivePath, targetSchema, ...scanned, ...result }));
}

async function scanArchive(path, limit) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header;
  let manifest;
  let validator;
  const hash = createHash("sha256");
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const parsed = decodeWorkflowArchiveLine(line);
      if (!header) {
        if (parsed.kind !== "header") throw new Error("Workflow archive must start with a header.");
        header = parsed;
        validator = createWorkflowArchiveValidator(header, { maxRecords: limit });
        continue;
      }
      if (parsed.kind === "manifest") {
        if (manifest) throw new Error("Workflow archive contains more than one manifest.");
        manifest = parsed;
        continue;
      }
      if (manifest) throw new Error("Workflow archive contains rows after its manifest.");
      validator.add(parsed);
      hash.update(encodeWorkflowArchiveLine(parsed));
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header || !validator) throw new Error("Workflow archive header is missing.");
  if (!manifest) throw new Error("Workflow archive is missing its manifest.");
  const summary = validator.finish(manifest);
  const sha256 = hash.digest("hex");
  if (sha256 !== manifest.sha256) throw new Error("Workflow archive checksum does not match its manifest.");
  return { format: header.format, sourceSchema: header.sourceSchema, rootRunIds: header.rootRunIds, ...summary, sha256 };
}

async function restoreArchive(path, connectionString, schema, scanned) {
  const pool = new pg.Pool({
    application_name: "open-agent-workflow-archive-restore",
    connectionString,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    max: 2,
  });
  const counts = {};
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '10s'");
    const database = await client.query("select current_database() as database");
    for (const table of WORKFLOW_ARCHIVE_TABLES) {
      const exists = await client.query("select to_regclass($1) is not null as exists", [`${schema}.${table}`]);
      if (exists.rows[0]?.exists !== true) throw new Error(`Target Workflow World is missing ${schema}.${table}; run its migrations first.`);
      const result = await client.query(
        `select count(*)::text as count from ${quote(schema)}.${quote(table)}`,
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new Error(`Target Workflow World is not empty (${table} already contains rows).`);
      }
    }
    const replayed = await replayRows(path, async (row) => {
      const columns = Object.keys(row.row).sort();
      if (columns.length === 0 || columns.some((column) => !/^[a-z_][a-z0-9_]*$/iu.test(column))) {
        throw new Error(`Archive row for ${row.table} contains an unsafe column name.`);
      }
      const values = columns.map((column) => row.row[column]);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      await client.query(
        `insert into ${quote(schema)}.${quote(row.table)} (${columns.map(quote).join(", ")}) values (${placeholders})`,
        values,
      );
      counts[row.table] = (counts[row.table] ?? 0) + 1;
    });
    if (replayed.count !== scanned.recordCount || replayed.sha256 !== scanned.sha256) {
      throw new Error("Archive changed while it was being restored; retry from a stable copy.");
    }
    await client.query("commit");
    return { targetDatabase: database.rows[0]?.database ?? null, inserted: replayed.count, insertedByTable: counts };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function replayRows(path, onRow) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const hash = createHash("sha256");
  let count = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const parsed = decodeWorkflowArchiveLine(line);
      if (parsed.kind !== "row") continue;
      if (!WORKFLOW_ARCHIVE_TABLES.includes(parsed.table)) throw new Error(`Unsupported archive table ${parsed.table}.`);
      hash.update(encodeWorkflowArchiveLine(parsed));
      await onRow(parsed);
      count += 1;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { count, sha256: hash.digest("hex") };
}

function quote(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function validateIdentifier(value, name) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error(`${name} must be a valid PostgreSQL identifier.`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`WORKFLOW_ARCHIVE_MAX_RECORDS must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}
