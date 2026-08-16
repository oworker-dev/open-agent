import { randomUUID } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { AssetStoreError } from "../../server/data/asset-store.ts";
import {
  readAgentSandboxWorkspaceQuota,
} from "../../lib/production-config.ts";

/**
 * The manifest is intentionally kept inside the durable Eve workspace. It is
 * a conservative reservation ledger for bytes materialized by import_asset;
 * deleting a file from the shell does not release a reservation, which keeps
 * a restarted turn from using untracked disk space.
 */
export const SANDBOX_IMPORT_MANIFEST_PATH = "/workspace/.open-agent/imported-assets.json";
const MANIFEST_VERSION = 1;
const MAX_MANIFEST_RECORDS = 10_000;

type ImportRecord = {
  readonly assetId: string;
  readonly bytes: number;
  readonly path: string;
  readonly state: "pending" | "ready";
};

type ImportManifest = {
  readonly records: readonly ImportRecord[];
  readonly version: 1;
};

type SandboxImportInput = {
  readonly assetId: string;
  readonly bytes: number;
  readonly content: ReadableStream<Uint8Array>;
  readonly destination: string;
};

// Eve serializes a durable session's turns, but keeping a process-local lock
// also protects hosts that invoke tools concurrently in one sandbox handle.
const locks = new Map<string, Promise<void>>();

/** Materialize one asset while holding the session's import reservation lock. */
export async function writeSandboxImport(
  sandbox: SandboxSession,
  input: SandboxImportInput,
): Promise<void> {
  await withSandboxImportLock(sandbox, async () => {
    const previous = await readManifest(sandbox);
    const nextRecords = reserve(previous.records, input.assetId, input.bytes, input.destination);
    await writeManifest(sandbox, { version: MANIFEST_VERSION, records: nextRecords.map((record) => ({ ...record, state: "pending" as const })) });

    const temporary = `${input.destination}.open-agent-import-${randomUUID()}.tmp`;
    let destinationCommitted = false;
    try {
      await sandbox.writeFile({ content: input.content, path: temporary });
      const renamed = await sandbox.run({
        command: `mv -f -- ${shellQuote(temporary)} ${shellQuote(input.destination)}`,
      });
      if (renamed.exitCode !== 0) {
        throw new Error(`Asset import rename failed: ${renamed.stderr || "rename command failed"}`);
      }
      destinationCommitted = true;
      await writeManifest(sandbox, {
        version: MANIFEST_VERSION,
        records: nextRecords.map((record) => ({ ...record, state: "ready" as const })),
      });
    } catch (error) {
      await sandbox.removePath({ force: true, path: temporary }).catch(() => undefined);
      // Once the destination was renamed, retaining a pending reservation is
      // safer than restoring an old record that no longer describes the file.
      if (!destinationCommitted) {
        await writeManifest(sandbox, previous).catch(() => undefined);
      }
      throw error;
    }
  });
}

function reserve(
  records: readonly ImportRecord[],
  assetId: string,
  bytes: number,
  destination: string,
): ImportRecord[] {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new AssetStoreError("invalid", "Imported asset bytes must be a positive safe integer.");
  }
  const quota = readAgentSandboxWorkspaceQuota();
  const retained = records.filter((record) => record.path !== destination);
  const used = retained.reduce((sum, record) => sum + record.bytes, 0);
  if (used + bytes > quota) {
    throw new AssetStoreError(
      "quota",
      `The session workspace import quota is ${quota} bytes; importing this asset would exceed the remaining capacity.`,
    );
  }
  if (retained.length >= MAX_MANIFEST_RECORDS) {
    throw new AssetStoreError("quota", "The session workspace has reached its imported-file limit.");
  }
  return [...retained, { assetId, bytes, path: destination, state: "pending" }];
}

async function readManifest(sandbox: SandboxSession): Promise<ImportManifest> {
  const content = await sandbox.readTextFile({ path: SANDBOX_IMPORT_MANIFEST_PATH });
  if (!content) return { version: MANIFEST_VERSION, records: [] };
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.records)) throw new Error("shape");
    if (parsed.records.length > MAX_MANIFEST_RECORDS) throw new Error("count");
    const records = parsed.records.map(parseRecord);
    const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
    if (!Number.isSafeInteger(bytes)) throw new Error("bytes");
    return { version: MANIFEST_VERSION, records };
  } catch {
    // A corrupt reservation ledger must fail closed; otherwise a restart could
    // silently reset the session's import quota.
    throw new AssetStoreError("invalid", "The sandbox asset reservation ledger is invalid.");
  }
}

async function writeManifest(sandbox: SandboxSession, manifest: ImportManifest): Promise<void> {
  const content = `${JSON.stringify(manifest)}\n`;
  if (typeof sandbox.run !== "function") {
    await sandbox.writeTextFile({ content, path: SANDBOX_IMPORT_MANIFEST_PATH });
    return;
  }
  const temporary = `${SANDBOX_IMPORT_MANIFEST_PATH}.open-agent-${randomUUID()}.tmp`;
  await sandbox.writeTextFile({ content, path: temporary });
  try {
    const result = await sandbox.run({
      command: `mv -f -- ${shellQuote(temporary)} ${shellQuote(SANDBOX_IMPORT_MANIFEST_PATH)}`,
    });
    if (result.exitCode !== 0) throw new Error(`Asset reservation ledger write failed: ${result.stderr || "rename command failed"}`);
  } catch (error) {
    await sandbox.removePath({ force: true, path: temporary }).catch(() => undefined);
    throw error;
  }
}

function parseRecord(value: unknown): ImportRecord {
  if (!isRecord(value)
    || typeof value.assetId !== "string"
    || typeof value.path !== "string"
    || !value.path.startsWith("/workspace/")
    || (value.state !== "pending" && value.state !== "ready")
    || typeof value.bytes !== "number"
    || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0) {
    throw new Error("record");
  }
  const bytes = value.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("record");
  return { assetId: value.assetId, bytes, path: value.path, state: value.state };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withSandboxImportLock<T>(sandbox: SandboxSession, work: () => Promise<T>): Promise<T> {
  const key = sandbox.id;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
