import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  createWorkflowArchiveValidator,
  decodeWorkflowArchiveLine,
  encodeWorkflowArchiveLine,
  WORKFLOW_ARCHIVE_FORMAT_VERSION,
  type WorkflowArchiveHeader,
  type WorkflowArchiveManifest,
  type WorkflowArchiveValidationSummary,
} from "./workflow-archive.ts";

export type VerifiedWorkflowArchive = WorkflowArchiveValidationSummary & {
  readonly format: typeof WORKFLOW_ARCHIVE_FORMAT_VERSION;
  readonly manifest: WorkflowArchiveManifest;
  readonly sourceSchema: string;
};

export async function verifyWorkflowArchiveFile(path: string): Promise<VerifiedWorkflowArchive> {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: WorkflowArchiveHeader | undefined;
  let manifest: WorkflowArchiveManifest | undefined;
  let validator: ReturnType<typeof createWorkflowArchiveValidator> | undefined;
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
      if (parsed.kind !== "row") throw new Error("Workflow archive contains a header after its first line.");
      if (manifest) throw new Error("Workflow archive contains rows after its manifest.");
      validator?.add(parsed);
      hash.update(encodeWorkflowArchiveLine(parsed));
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header || header.format !== WORKFLOW_ARCHIVE_FORMAT_VERSION) {
    throw new Error("Workflow archive header is missing or unsupported.");
  }
  if (!manifest) throw new Error("Workflow archive is missing its manifest.");
  if (!validator) throw new Error("Workflow archive validator was not initialized.");
  const summary = validator.finish(manifest);
  const sha256 = hash.digest("hex");
  if (sha256 !== manifest.sha256) throw new Error("Workflow archive checksum does not match its manifest.");
  return {
    ...summary,
    format: header.format,
    manifest,
    sourceSchema: header.sourceSchema,
  };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
