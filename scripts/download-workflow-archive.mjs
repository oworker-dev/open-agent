import { resolve } from "node:path";

import { verifyWorkflowArchiveFile } from "../lib/workflow-archive-file.ts";
import { closeAgentDatabasePools } from "../server/data/agent-database.ts";
import { createPostgresWorkflowArchiveStoreFromEnvironment } from "../server/data/workflow-archive-store.ts";
import {
  createWorkflowArchiveObjectStore,
  readWorkflowArchiveObjectStoreConfig,
} from "../server/data/workflow-archive-object-store.ts";

const args = parseArgs(process.argv.slice(2));
const rootRunId = args.rootRunId || process.env.WORKFLOW_ARCHIVE_ROOT_ID?.trim();
const outputValue = args.output || process.env.WORKFLOW_ARCHIVE_OUTPUT?.trim();
if (!rootRunId) throw new Error("Provide --root-run-id or WORKFLOW_ARCHIVE_ROOT_ID.");
if (!outputValue) throw new Error("Provide --output or WORKFLOW_ARCHIVE_OUTPUT.");
const output = resolve(outputValue);
const archiveStore = createPostgresWorkflowArchiveStoreFromEnvironment(process.env);
if (!archiveStore) throw new Error("AGENT_DATABASE_URL is required.");
const objectStore = createWorkflowArchiveObjectStore(readWorkflowArchiveObjectStoreConfig(process.env));

try {
  const record = await archiveStore.find(rootRunId);
  if (!record || record.status !== "completed" || !record.objectKey || !record.objectSha256 || record.objectSizeBytes === undefined) {
    throw new Error("The requested Workflow root does not have a completed archive record.");
  }
  await objectStore.downloadVerified({
    key: record.objectKey,
    path: output,
    sha256: record.objectSha256,
    sizeBytes: record.objectSizeBytes,
  });
  const verified = await verifyWorkflowArchiveFile(output);
  if (verified.rootRunIds.length !== 1 || verified.rootRunIds[0] !== rootRunId) {
    throw new Error("The downloaded Workflow archive contains a different root.");
  }
  if (verified.manifest.sha256 !== record.manifestSha256) {
    throw new Error("The downloaded Workflow archive manifest differs from its archive record.");
  }
  console.log(JSON.stringify({
    ok: true,
    manifestSha256: verified.manifest.sha256,
    objectSha256: record.objectSha256,
    output,
    recordCount: verified.recordCount,
    rootRunId,
    runCount: verified.runCount,
    sizeBytes: record.objectSizeBytes,
  }));
} finally {
  objectStore.close();
  await closeAgentDatabasePools();
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root-run-id") result.rootRunId = required(argv[++index], argument);
    else if (argument === "--output") result.output = required(argv[++index], argument);
    else if (argument === "--help") {
      console.log("Usage: node scripts/download-workflow-archive.mjs --root-run-id <id> --output <file>");
      process.exit(0);
    } else throw new Error(`Unknown argument ${argument}.`);
  }
  return result;
}

function required(value, name) {
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
