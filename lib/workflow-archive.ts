import { createHash } from "node:crypto";

/**
 * Versioned, line-oriented archive records for a complete Workflow root tree.
 * Binary PostgreSQL fields are represented explicitly so an archive can be
 * restored without relying on driver-specific JSON serialization.
 */
export const WORKFLOW_ARCHIVE_FORMAT_VERSION = "open-agent.workflow-archive.v2";

export type WorkflowArchiveHeader = {
  readonly kind: "header";
  readonly format: typeof WORKFLOW_ARCHIVE_FORMAT_VERSION;
  readonly createdAt: string;
  readonly sourceSchema: string;
  readonly rootRunIds: readonly string[];
};

export type WorkflowArchiveRow = {
  readonly kind: "row";
  readonly table: string;
  readonly row: Record<string, unknown>;
};

export type WorkflowArchiveManifest = {
  readonly kind: "manifest";
  readonly format: typeof WORKFLOW_ARCHIVE_FORMAT_VERSION;
  readonly recordCount: number;
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly sha256: string;
};

export type WorkflowArchiveLine = WorkflowArchiveHeader | WorkflowArchiveRow | WorkflowArchiveManifest;

/** Tables that belong to one complete Workflow root tree. Keeping this list
 * explicit prevents an archive from silently accepting application tables or
 * a future table whose restore semantics have not been reviewed. */
export const WORKFLOW_ARCHIVE_TABLES = [
  "workflow_runs",
  "workflow_steps",
  "workflow_events",
  "workflow_hooks",
  "workflow_waits",
  "workflow_stream_chunks",
  "workflow_event_slots",
] as const;

export type WorkflowArchiveValidationSummary = {
  readonly recordCount: number;
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly runCount: number;
  readonly rootRunIds: readonly string[];
};

export function createWorkflowArchiveHeader(input: {
  readonly createdAt: string;
  readonly sourceSchema: string;
  readonly rootRunIds: readonly string[];
}): WorkflowArchiveHeader {
  if (!isIsoDate(input.createdAt)) throw new TypeError("createdAt must be an ISO timestamp.");
  if (!isIdentifier(input.sourceSchema)) throw new TypeError("sourceSchema must be a valid identifier.");
  const rootRunIds = [...new Set(input.rootRunIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (rootRunIds.length === 0) throw new TypeError("rootRunIds must contain at least one id.");
  return {
    kind: "header",
    format: WORKFLOW_ARCHIVE_FORMAT_VERSION,
    createdAt: input.createdAt,
    sourceSchema: input.sourceSchema,
    rootRunIds,
  };
}

export function encodeWorkflowArchiveLine(line: WorkflowArchiveLine): string {
  return `${JSON.stringify(encodeArchiveValue(line))}\n`;
}

export function decodeWorkflowArchiveLine(value: string): WorkflowArchiveLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Workflow archive contains invalid JSON.", { cause: error });
  }
  const decoded = decodeArchiveValue(parsed);
  if (!isRecord(decoded) || typeof decoded.kind !== "string") {
    throw new Error("Workflow archive line is missing a kind.");
  }
  if (decoded.kind === "header") {
    if (decoded.format !== WORKFLOW_ARCHIVE_FORMAT_VERSION ||
        typeof decoded.createdAt !== "string" ||
        typeof decoded.sourceSchema !== "string" ||
        !Array.isArray(decoded.rootRunIds) ||
        decoded.rootRunIds.some((id) => typeof id !== "string")) {
      throw new Error("Workflow archive header is invalid.");
    }
    return decoded as unknown as WorkflowArchiveHeader;
  }
  if (decoded.kind === "row") {
    if (typeof decoded.table !== "string" || !isRecord(decoded.row)) {
      throw new Error("Workflow archive row is invalid.");
    }
    return decoded as unknown as WorkflowArchiveRow;
  }
  if (decoded.kind === "manifest") {
    const tableCounts = decoded.tableCounts;
    const recordCount = decoded.recordCount;
    const sha256 = decoded.sha256;
    if (decoded.format !== WORKFLOW_ARCHIVE_FORMAT_VERSION ||
        !Number.isSafeInteger(recordCount) ||
        (recordCount as number) < 0 ||
        !isRecord(tableCounts) ||
        typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error("Workflow archive manifest is invalid.");
    }
    if (Object.values(tableCounts).some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
      throw new Error("Workflow archive manifest table counts are invalid.");
    }
    return decoded as unknown as WorkflowArchiveManifest;
  }
  throw new Error(`Workflow archive contains unknown line kind ${JSON.stringify(decoded.kind)}.`);
}

/** Hashes exactly the encoded row lines, excluding header and manifest. */
export function createWorkflowArchiveAccumulator() {
  const hash = createHash("sha256");
  const tableCounts = new Map<string, number>();
  let recordCount = 0;
  return {
    add(row: WorkflowArchiveRow): string {
      if (!isIdentifier(row.table)) throw new TypeError("Archive table must be a valid identifier.");
      const line = encodeWorkflowArchiveLine(row);
      hash.update(line);
      recordCount += 1;
      tableCounts.set(row.table, (tableCounts.get(row.table) ?? 0) + 1);
      return line;
    },
    finish(): WorkflowArchiveManifest {
      return {
        kind: "manifest",
        format: WORKFLOW_ARCHIVE_FORMAT_VERSION,
        recordCount,
        tableCounts: Object.fromEntries([...tableCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
        sha256: hash.digest("hex"),
      };
    },
  };
}

/**
 * Incrementally validates archive rows without retaining payloads in memory.
 * Restore tooling can therefore scan multi-gigabyte archives before deciding
 * whether to write them into an isolated Workflow World.
 */
export function createWorkflowArchiveValidator(
  header: WorkflowArchiveHeader,
  options: { readonly maxRecords?: number } = {},
) {
  const maxRecords = options.maxRecords ?? 5_000_000;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 50_000_000) {
    throw new RangeError("Workflow archive maxRecords must be an integer from 1 to 50000000.");
  }
  const expectedRoots = new Set(header.rootRunIds);
  if (expectedRoots.size === 0 || expectedRoots.size !== header.rootRunIds.length) {
    throw new Error("Workflow archive header must contain unique root run ids.");
  }
  const allowedTables = new Set<string>(WORKFLOW_ARCHIVE_TABLES);
  const tableCounts = new Map<string, number>();
  const seen = new Map<string, Set<string>>();
  const runIds = new Set<string>();
  const runRoots = new Map<string, string>();
  let recordCount = 0;

  return {
    add(row: WorkflowArchiveRow): void {
      recordCount += 1;
      if (recordCount > maxRecords) throw new Error(`Workflow archive exceeds the ${maxRecords} record safety bound.`);
      if (!allowedTables.has(row.table)) throw new Error(`Workflow archive contains unsupported table ${JSON.stringify(row.table)}.`);
      const key = archivePrimaryKey(row);
      const tableSeen = seen.get(row.table) ?? new Set<string>();
      if (tableSeen.has(key)) throw new Error(`Workflow archive contains a duplicate ${row.table} row (${key}).`);
      tableSeen.add(key);
      seen.set(row.table, tableSeen);
      tableCounts.set(row.table, (tableCounts.get(row.table) ?? 0) + 1);

      if (row.table === "workflow_runs") {
        const id = requiredText(row.row.id, "workflow_runs.id");
        runIds.add(id);
        const root = archiveRootRunId(row.row, id);
        if (!expectedRoots.has(root)) {
          throw new Error(`Workflow run ${JSON.stringify(id)} is outside the requested root tree.`);
        }
        runRoots.set(id, root);
        return;
      }
      const runId = requiredText(row.row.run_id, `${row.table}.run_id`);
      // Run rows may appear after dependent rows in a hand-created archive;
      // defer membership checking until finish() so streaming order is not a
      // hidden restore requirement.
      const dependent = seen.get("__dependent_run_ids__") ?? new Set<string>();
      dependent.add(runId);
      seen.set("__dependent_run_ids__", dependent);
    },
    finish(manifest: WorkflowArchiveManifest): WorkflowArchiveValidationSummary {
      if (manifest.format !== WORKFLOW_ARCHIVE_FORMAT_VERSION) throw new Error("Workflow archive manifest format is unsupported.");
      if (manifest.recordCount !== recordCount) throw new Error(`Workflow archive record count mismatch: ${recordCount} != ${manifest.recordCount}.`);
      const actualCounts = Object.fromEntries(
        [...tableCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
      if (JSON.stringify(actualCounts) !== JSON.stringify(manifest.tableCounts)) {
        throw new Error("Workflow archive table counts do not match its manifest.");
      }
      const dependent = seen.get("__dependent_run_ids__") ?? new Set<string>();
      for (const runId of dependent) {
        if (!runIds.has(runId)) throw new Error(`Workflow archive row references missing Workflow run ${JSON.stringify(runId)}.`);
      }
      const roots = new Set(runRoots.values());
      for (const root of expectedRoots) {
        if (!roots.has(root)) throw new Error(`Workflow archive is missing requested root ${JSON.stringify(root)}.`);
      }
      return {
        recordCount,
        tableCounts: actualCounts,
        runCount: runIds.size,
        rootRunIds: [...roots].sort(),
      };
    },
  };
}

function archivePrimaryKey(row: WorkflowArchiveRow): string {
  switch (row.table) {
    case "workflow_runs": return requiredText(row.row.id, "workflow_runs.id");
    case "workflow_steps": return requiredText(row.row.step_id, "workflow_steps.step_id");
    case "workflow_events": return `${requiredText(row.row.run_id, "workflow_events.run_id")}\u0000${requiredText(row.row.id, "workflow_events.id")}`;
    case "workflow_hooks": return requiredText(row.row.hook_id, "workflow_hooks.hook_id");
    case "workflow_waits": return requiredText(row.row.wait_id, "workflow_waits.wait_id");
    case "workflow_stream_chunks": return `${requiredText(row.row.stream_id, "workflow_stream_chunks.stream_id")}\u0000${requiredText(row.row.id, "workflow_stream_chunks.id")}`;
    case "workflow_event_slots": return requiredText(row.row.run_id, "workflow_event_slots.run_id");
    default: throw new Error(`Workflow archive contains unsupported table ${JSON.stringify(row.table)}.`);
  }
}

function archiveRootRunId(row: Record<string, unknown>, fallback: string): string {
  const attributes = row.attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    const root = (attributes as Record<string, unknown>)["$rootRunId"];
    if (typeof root === "string" && root.trim()) return root;
  }
  return fallback;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error(`Workflow archive row requires a bounded ${name}.`);
  }
  return value;
}

export function encodeArchiveValue(value: unknown): unknown {
  // PostgreSQL timestamp columns are returned by node-postgres as Date
  // instances. JSON.stringify would otherwise turn them into `{}`, making a
  // validated archive impossible to restore into a timestamp column.
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("Workflow archive contains an invalid Date.");
    return { $date: value.toISOString() };
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { $binary: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encodeArchiveValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeArchiveValue(entry)]));
  }
  return value;
}

export function decodeArchiveValue(value: unknown): unknown {
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value.$binary === "string") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value.$binary)) throw new Error("Workflow archive contains invalid binary data.");
    return Buffer.from(value.$binary, "base64");
  }
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value.$date === "string") {
    if (!isIsoDate(value.$date)) throw new Error("Workflow archive contains an invalid date.");
    return new Date(value.$date);
  }
  if (Array.isArray(value)) return value.map(decodeArchiveValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeArchiveValue(entry)]));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: string): boolean {
  return /^[a-z_][a-z0-9_]*$/iu.test(value);
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.includes("T");
}
