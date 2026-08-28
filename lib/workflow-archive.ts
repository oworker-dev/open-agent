import { createHash } from "node:crypto";

/**
 * Versioned, line-oriented archive records for a complete Workflow root tree.
 * Binary PostgreSQL fields are represented explicitly so an archive can be
 * restored without relying on driver-specific JSON serialization.
 */
export const WORKFLOW_ARCHIVE_FORMAT_VERSION = "open-agent.workflow-archive.v1";

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

export function encodeArchiveValue(value: unknown): unknown {
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
