import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  decodeWorkflowArchiveLine,
  encodeWorkflowArchiveLine,
  createWorkflowArchiveValidator,
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
let validator;
const hash = createHash("sha256");
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed = decodeWorkflowArchiveLine(line);
    if (!header) {
      if (parsed.kind !== "header") throw new Error("Workflow archive must start with a header.");
      header = parsed;
      validator = createWorkflowArchiveValidator(header);
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

if (!header || header.format !== WORKFLOW_ARCHIVE_FORMAT_VERSION) throw new Error("Workflow archive header is missing or unsupported.");
if (!manifest) throw new Error("Workflow archive is missing its manifest.");
if (!validator) throw new Error("Workflow archive validator was not initialized.");
const summary = validator.finish(manifest);
const sha256 = hash.digest("hex");
if (sha256 !== manifest.sha256) throw new Error("Workflow archive checksum does not match its manifest.");

console.log(JSON.stringify({
  ok: true,
  format: header.format,
  sourceSchema: header.sourceSchema,
  rootRunIds: header.rootRunIds,
  ...summary,
  sha256,
}));
