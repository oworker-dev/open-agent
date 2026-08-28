import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  decodeWorkflowArchiveLine,
  encodeWorkflowArchiveLine,
  WORKFLOW_ARCHIVE_FORMAT_VERSION,
} from "../lib/workflow-archive.ts";

const path = resolve(process.argv[2] || process.env.WORKFLOW_ARCHIVE_INPUT || "");
if (!process.argv[2] && !process.env.WORKFLOW_ARCHIVE_INPUT?.trim()) {
  throw new Error("Provide an archive path or WORKFLOW_ARCHIVE_INPUT.");
}

const input = createReadStream(path);
const lines = createInterface({ input, crlfDelay: Infinity });
let header;
let manifest;
let rows = 0;
const tableCounts = new Map();
const hash = createHash("sha256");
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed = decodeWorkflowArchiveLine(line);
    if (!header) {
      if (parsed.kind !== "header") throw new Error("Workflow archive must start with a header.");
      header = parsed;
      continue;
    }
    if (parsed.kind === "manifest") {
      if (manifest) throw new Error("Workflow archive contains more than one manifest.");
      manifest = parsed;
      continue;
    }
    if (manifest) throw new Error("Workflow archive contains rows after its manifest.");
    hash.update(encodeWorkflowArchiveLine(parsed));
    rows += 1;
    tableCounts.set(parsed.table, (tableCounts.get(parsed.table) || 0) + 1);
  }
} finally {
  lines.close();
  input.destroy();
}

if (!header || header.format !== WORKFLOW_ARCHIVE_FORMAT_VERSION) throw new Error("Workflow archive header is missing or unsupported.");
if (!manifest) throw new Error("Workflow archive is missing its manifest.");
if (manifest.recordCount !== rows) throw new Error(`Workflow archive record count mismatch: ${rows} != ${manifest.recordCount}.`);
const actualCounts = Object.fromEntries([...tableCounts.entries()].sort(([a], [b]) => a.localeCompare(b)));
if (JSON.stringify(actualCounts) !== JSON.stringify(manifest.tableCounts)) throw new Error("Workflow archive table counts do not match its manifest.");
const sha256 = hash.digest("hex");
if (sha256 !== manifest.sha256) throw new Error("Workflow archive checksum does not match its manifest.");

console.log(JSON.stringify({
  ok: true,
  format: header.format,
  sourceSchema: header.sourceSchema,
  rootRunIds: header.rootRunIds,
  recordCount: rows,
  tableCounts: actualCounts,
  sha256,
}));
