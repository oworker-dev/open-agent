import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import type { Pool, PoolClient } from "pg";

import {
  createWorkflowArchiveAccumulator,
  createWorkflowArchiveHeader,
  encodeWorkflowArchiveLine,
  type WorkflowArchiveManifest,
} from "./workflow-archive.ts";
import { isTerminalStatus } from "./workflow-retention.ts";

const TABLE_SPECS = [
  { name: "workflow_runs", runColumn: "id", order: ["id"], batchSize: 250 },
  { name: "workflow_steps", runColumn: "run_id", order: ["step_id"], batchSize: 500 },
  { name: "workflow_events", runColumn: "run_id", order: ["id"], batchSize: 500 },
  { name: "workflow_hooks", runColumn: "run_id", order: ["hook_id"], batchSize: 250 },
  { name: "workflow_waits", runColumn: "run_id", order: ["wait_id"], batchSize: 250 },
  { name: "workflow_stream_chunks", runColumn: "run_id", order: ["stream_id", "id"], batchSize: 500 },
  { name: "workflow_event_slots", runColumn: "run_id", order: ["run_id"], batchSize: 250 },
] as const;

type WorkflowRunRow = {
  readonly id: string;
  readonly rootRunId: string;
  readonly status: string;
};

export type WorkflowArchiveExportResult = {
  readonly manifest: WorkflowArchiveManifest;
  readonly rootRunIds: readonly string[];
  readonly runCount: number;
  readonly runIds: readonly string[];
  readonly sourceSchema: string;
};

/**
 * Export one or more complete Workflow root trees from a repeatable, read-only
 * snapshot. This keeps every table mutually consistent without locking live
 * Workflow writers or retaining archive payloads in memory.
 */
export async function exportWorkflowRootTrees(input: {
  readonly createdAt: string;
  readonly output: string;
  readonly pool: Pick<Pool, "connect">;
  readonly rootRunIds: readonly string[];
  readonly schema: string;
  readonly signal?: AbortSignal;
}): Promise<WorkflowArchiveExportResult> {
  const schema = validateIdentifier(input.schema, "schema");
  const requestedRoots = [...new Set(input.rootRunIds.map((value) => value.trim()).filter(Boolean))];
  if (requestedRoots.length === 0) throw new Error("Provide at least one Workflow root run id.");
  if (requestedRoots.some((value) => value.length > 512 || /\s/u.test(value))) {
    throw new Error("Root run ids must be bounded identifiers without whitespace.");
  }
  throwIfAborted(input.signal);
  await mkdir(dirname(input.output), { recursive: true });

  const client = await input.pool.connect();
  const writer = createWriteStream(input.output, { flags: "wx", mode: 0o600 });
  let committed = false;
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const runs = await loadRootTree(client, schema, requestedRoots);
    if (runs.length === 0) throw new Error("No Workflow runs matched the requested root ids.");
    const discoveredRoots = new Set(runs.map((run) => run.rootRunId));
    const missingRoot = requestedRoots.find((root) => !discoveredRoots.has(root));
    if (missingRoot) throw new Error(`Requested Workflow root was not found: ${missingRoot}.`);
    const active = runs.find((run) => !isTerminalStatus(run.status));
    if (active) throw new Error(`Refusing to archive an active Workflow root (${active.id}).`);

    const header = createWorkflowArchiveHeader({
      createdAt: input.createdAt,
      rootRunIds: requestedRoots,
      sourceSchema: schema,
    });
    await writeEncodedLine(writer, encodeWorkflowArchiveLine(header));
    const accumulator = createWorkflowArchiveAccumulator();
    const runIds = runs.map((run) => run.id);
    for (const spec of TABLE_SPECS) {
      throwIfAborted(input.signal);
      if (!(await tableExists(client, schema, spec.name))) continue;
      await readTable(client, schema, spec, runIds, input.signal, async (row) => {
        await writeEncodedLine(writer, accumulator.add({ kind: "row", table: spec.name, row }));
      });
    }
    const manifest = accumulator.finish();
    await writeEncodedLine(writer, encodeWorkflowArchiveLine(manifest));
    writer.end();
    await finished(writer);
    throwIfAborted(input.signal);
    await client.query("commit");
    committed = true;
    return {
      manifest,
      rootRunIds: header.rootRunIds,
      runCount: runs.length,
      runIds,
      sourceSchema: schema,
    };
  } catch (error) {
    writer.destroy();
    await client.query("rollback").catch(() => undefined);
    await unlink(input.output).catch(() => undefined);
    throw error;
  } finally {
    if (!committed) writer.destroy();
    client.release();
  }
}

async function loadRootTree(
  client: Pick<PoolClient, "query">,
  schema: string,
  roots: readonly string[],
): Promise<WorkflowRunRow[]> {
  const result = await client.query<{
    id: string;
    root_run_id: string | null;
    status: string;
  }>(
    `select id, status::text as status,
            coalesce(attributes->>'$rootRunId', id) as root_run_id
       from ${quote(schema)}.workflow_runs
      where id = any($1::varchar[])
         or attributes->>'$rootRunId' = any($1::varchar[])
      order by coalesce(attributes->>'$rootRunId', id), created_at, id`,
    [roots],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    rootRunId: String(row.root_run_id || row.id),
    status: String(row.status),
  }));
}

async function tableExists(client: Pick<PoolClient, "query">, schema: string, table: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "select to_regclass($1) is not null as exists",
    [`${schema}.${table}`],
  );
  return result.rows[0]?.exists === true;
}

async function readTable(
  client: Pick<PoolClient, "query">,
  schema: string,
  spec: (typeof TABLE_SPECS)[number],
  runIds: readonly string[],
  signal: AbortSignal | undefined,
  onRow: (row: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let cursor: readonly unknown[] | undefined;
  for (;;) {
    throwIfAborted(signal);
    const values: unknown[] = [runIds];
    const conditions = [`${quote(spec.runColumn)} = any($1::varchar[])`];
    if (cursor) {
      if (spec.order.length === 1) {
        values.push(cursor[0]);
        conditions.push(`${quote(spec.order[0])} > $${values.length}`);
      } else {
        values.push(cursor[0], cursor[1]);
        conditions.push(`(${spec.order.map(quote).join(", ")}) > ($2, $3)`);
      }
    }
    values.push(spec.batchSize);
    const result = await client.query<Record<string, unknown>>(
      `select * from ${quote(schema)}.${quote(spec.name)}
        where ${conditions.join(" and ")}
        order by ${spec.order.map(quote).join(", ")}
        limit $${values.length}`,
      values,
    );
    if (result.rows.length === 0) return;
    for (const row of result.rows) {
      throwIfAborted(signal);
      await onRow(row);
    }
    const last = result.rows.at(-1);
    if (!last) return;
    cursor = spec.order.map((column) => last[column]);
    if (result.rows.length < spec.batchSize) return;
  }
}

async function writeEncodedLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
  if (!stream.write(line)) await new Promise<void>((resolvePromise, reject) => {
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Workflow archive was cancelled.");
}

function validateIdentifier(value: string, name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error(`${name} must be a valid PostgreSQL identifier.`);
  return value;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
