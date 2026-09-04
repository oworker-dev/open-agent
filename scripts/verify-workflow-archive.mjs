import { resolve } from "node:path";

import { verifyWorkflowArchiveFile } from "../lib/workflow-archive-file.ts";

const configuredPath = process.argv[2] || process.env.WORKFLOW_ARCHIVE_INPUT?.trim();
if (!configuredPath) throw new Error("Provide an archive path or WORKFLOW_ARCHIVE_INPUT.");
const result = await verifyWorkflowArchiveFile(resolve(configuredPath));

console.log(JSON.stringify({
  ok: true,
  format: result.format,
  manifestSha256: result.manifest.sha256,
  recordCount: result.recordCount,
  rootRunIds: result.rootRunIds,
  runCount: result.runCount,
  sourceSchema: result.sourceSchema,
  tableCounts: result.tableCounts,
}));
