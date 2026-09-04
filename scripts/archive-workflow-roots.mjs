import { resolve } from "node:path";
import pg from "pg";

import { exportWorkflowRootTrees } from "../lib/workflow-archive-export.ts";

const { Pool } = pg;
const args = parseArgs(process.argv.slice(2));
const connectionString = process.env.WORKFLOW_POSTGRES_URL?.trim();
if (!connectionString) throw new Error("WORKFLOW_POSTGRES_URL is required.");
const sourceSchema = validateIdentifier(
  args.schema || process.env.WORKFLOW_POSTGRES_SCHEMA?.trim() || "workflow",
  "schema",
);
const rootRunIds = (args.rootIds || process.env.WORKFLOW_ARCHIVE_ROOT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (rootRunIds.length === 0) throw new Error("Provide --root-run-id or WORKFLOW_ARCHIVE_ROOT_IDS.");
const configuredOutput = args.output || process.env.WORKFLOW_ARCHIVE_OUTPUT?.trim();
if (!configuredOutput) throw new Error("Provide --output or WORKFLOW_ARCHIVE_OUTPUT.");
const output = resolve(configuredOutput);
const queryTimeoutMs = boundedInteger("WORKFLOW_POSTGRES_QUERY_TIMEOUT_MS", 15_000, 100, 300_000);
const pool = new Pool({
  application_name: "open-agent-workflow-archive",
  connectionString,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  query_timeout: queryTimeoutMs,
  statement_timeout: queryTimeoutMs,
  max: 2,
});

try {
  const result = await exportWorkflowRootTrees({
    createdAt: process.env.WORKFLOW_ARCHIVE_CREATED_AT?.trim() || new Date().toISOString(),
    output,
    pool,
    rootRunIds,
    schema: sourceSchema,
  });
  console.log(JSON.stringify({
    ok: true,
    output,
    format: result.manifest.format,
    manifestSha256: result.manifest.sha256,
    recordCount: result.manifest.recordCount,
    rootRunIds: result.rootRunIds,
    runCount: result.runCount,
    sourceSchema,
  }));
} finally {
  await pool.end();
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root-run-id") {
      result.rootIds = `${result.rootIds ? `${result.rootIds},` : ""}${required(argv[++index], argument)}`;
    } else if (argument === "--output") result.output = required(argv[++index], argument);
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

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function validateIdentifier(value, name) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error(`${name} must be a valid PostgreSQL identifier.`);
  return value;
}
