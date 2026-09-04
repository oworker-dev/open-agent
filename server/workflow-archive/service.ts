import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { exportWorkflowRootTrees } from "../../lib/workflow-archive-export.ts";
import { sha256File, verifyWorkflowArchiveFile } from "../../lib/workflow-archive-file.ts";
import type { WorkflowArchiveStore } from "../data/workflow-archive-store.ts";
import {
  workflowArchiveObjectKey,
  type WorkflowArchiveObjectStore,
} from "../data/workflow-archive-object-store.ts";

export type WorkflowArchiveWorkerConfig = {
  readonly discoveryLimit: number;
  readonly leaseMs: number;
  readonly maxRoots: number;
  readonly objectPrefix: string;
  readonly olderThanMs: number;
  readonly retryBaseMs: number;
  readonly schema: string;
  readonly spoolDirectory?: string;
};

export type WorkflowArchivePassResult = {
  readonly archived: number;
  readonly candidates: number;
  readonly failed: number;
  readonly skipped: number;
};

export async function runWorkflowArchivePass(input: {
  readonly archiveStore: WorkflowArchiveStore;
  readonly config: WorkflowArchiveWorkerConfig;
  readonly now: Date;
  readonly objectStore: WorkflowArchiveObjectStore;
  readonly signal?: AbortSignal;
  readonly workflowPool: Pick<Pool, "connect" | "query">;
}): Promise<WorkflowArchivePassResult> {
  const cursor = await input.archiveStore.readDiscoveryCursor();
  const candidates = await findWorkflowArchiveCandidates(
    input.workflowPool,
    input.config.schema,
    new Date(input.now.getTime() - input.config.olderThanMs),
    input.config.discoveryLimit,
    cursor,
  );
  await input.archiveStore.recordDiscovery({
    candidates,
    cursor: candidates.length === input.config.discoveryLimit
      ? {
          completedAt: candidates.at(-1)?.sourceCompletedAt ?? "",
          rootRunId: candidates.at(-1)?.rootRunId ?? "",
        }
      : undefined,
  });
  let archived = 0;
  let failed = 0;
  let skipped = 0;
  for (let index = 0; index < input.config.maxRoots; index += 1) {
    if (input.signal?.aborted) break;
    const claim = await input.archiveStore.claimNext(input.config.leaseMs);
    if (!claim?.claimToken) {
      skipped += input.config.maxRoots - index;
      break;
    }
    const rootRunId = claim.rootRunId;
    const heartbeat = startLeaseHeartbeat({
      archiveStore: input.archiveStore,
      claimToken: claim.claimToken,
      leaseMs: input.config.leaseMs,
      rootRunId,
    });
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(input.config.spoolDirectory || tmpdir(), "open-agent-workflow-archive-"));
      const path = join(directory, "archive.ndjson");
      const exported = await exportWorkflowRootTrees({
        createdAt: claim.archiveCreatedAt,
        output: path,
        pool: input.workflowPool,
        rootRunIds: [rootRunId],
        schema: input.config.schema,
        signal: input.signal,
      });
      const verified = await verifyWorkflowArchiveFile(path);
      if (verified.rootRunIds.length !== 1 || verified.rootRunIds[0] !== rootRunId) {
        throw new Error("Workflow archive verification returned a different root tree.");
      }
      if (verified.manifest.sha256 !== exported.manifest.sha256) {
        throw new Error("Workflow archive manifest changed between export and verification.");
      }
      const [file, objectSha256] = await Promise.all([stat(path), sha256File(path)]);
      const objectKey = workflowArchiveObjectKey(input.config.objectPrefix, rootRunId);
      await input.objectStore.putVerified({
        key: objectKey,
        manifestSha256: verified.manifest.sha256,
        path,
        sha256: objectSha256,
        signal: input.signal,
        sizeBytes: file.size,
      });
      await assertWorkflowRootArchivable(input.workflowPool, input.config.schema, rootRunId, new Date());
      await input.archiveStore.complete({
        claimToken: claim.claimToken,
        manifestSha256: verified.manifest.sha256,
        objectKey,
        objectSha256,
        objectSizeBytes: file.size,
        recordCount: verified.recordCount,
        rootRunId,
        runCount: verified.runCount,
      });
      archived += 1;
    } catch (error) {
      failed += 1;
      await input.archiveStore.fail(
        rootRunId,
        claim.claimToken,
        error instanceof Error ? error.message : String(error),
        retryDelay(claim.attemptCount, input.config.retryBaseMs),
      ).catch(() => false);
    } finally {
      heartbeat.stop();
      if (directory) await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }
  }
  return { archived, candidates: candidates.length, failed, skipped };
}

export async function findWorkflowArchiveCandidates(
  pool: Pick<Pool, "query">,
  schemaName: string,
  cutoff: Date,
  limit: number,
  cursor?: { readonly completedAt: string; readonly rootRunId: string },
): Promise<{ readonly rootRunId: string; readonly sourceCompletedAt: string }[]> {
  const schema = quoteIdentifier(schemaName);
  const result = await pool.query<{ completed_at: Date | string; root_run_id: string }>(
    `with run_roots as (
       select id, status::text as status, completed_at,
              coalesce(attributes->>'$rootRunId', id) as root_run_id
         from ${schema}.workflow_runs
     ), eligible as (
       select root_run_id, max(completed_at) as completed_at
         from run_roots
        group by root_run_id
       having bool_and(status in ('completed', 'failed', 'cancelled'))
          and bool_and(completed_at is not null)
          and max(completed_at) <= $1
     )
     select eligible.root_run_id, eligible.completed_at
       from eligible
      where not exists (
        select 1
          from ${schema}.workflow_hooks h
          join run_roots r on r.id = h.run_id
         where r.root_run_id = eligible.root_run_id
           and (h.token_retention_until is null or h.token_retention_until > now())
      )
        and ($2::timestamptz is null or (eligible.completed_at, eligible.root_run_id) > ($2, $3))
      order by eligible.completed_at, eligible.root_run_id
      limit $4`,
    [cutoff, cursor?.completedAt ?? null, cursor?.rootRunId ?? null, limit],
  );
  return result.rows.map((row) => ({
    rootRunId: String(row.root_run_id),
    sourceCompletedAt: toIso(row.completed_at),
  }));
}

export async function assertWorkflowRootArchivable(
  pool: Pick<Pool, "query">,
  schemaName: string,
  rootRunId: string,
  now: Date,
): Promise<void> {
  const schema = quoteIdentifier(schemaName);
  const result = await pool.query<{ active: boolean; members: string; protected: boolean }>(
    `with members as (
       select id, status::text as status
         from ${schema}.workflow_runs
        where id = $1 or attributes->>'$rootRunId' = $1
     )
     select count(*) filter (where status not in ('completed', 'failed', 'cancelled')) > 0 as active,
            count(*)::text as members,
            exists (
              select 1 from ${schema}.workflow_hooks h
               where h.run_id in (select id from members)
                 and (h.token_retention_until is null or h.token_retention_until > $2)
            ) as protected
       from members`,
    [rootRunId, now],
  );
  const row = result.rows[0];
  if (!row || Number(row.members) === 0) throw new Error("Workflow root disappeared before archive commit.");
  if (row.active) throw new Error("Workflow root became active before archive commit.");
  if (row.protected) throw new Error("Workflow root gained a retained Hook before archive commit.");
}

function startLeaseHeartbeat(input: {
  readonly archiveStore: WorkflowArchiveStore;
  readonly claimToken: string;
  readonly leaseMs: number;
  readonly rootRunId: string;
}): { stop(): void } {
  const timer = setInterval(() => {
    void input.archiveStore.renew(input.rootRunId, input.claimToken, input.leaseMs).catch(() => false);
  }, Math.max(30_000, Math.floor(input.leaseMs / 3)));
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function retryDelay(attemptCount: number, baseMs: number): number {
  return Math.min(24 * 60 * 60 * 1_000, baseMs * 2 ** Math.min(8, Math.max(0, attemptCount - 1)));
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error("WORKFLOW_POSTGRES_SCHEMA is invalid.");
  return `"${value}"`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
