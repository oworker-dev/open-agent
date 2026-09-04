import { readWorkflowArchiveObjectStoreConfig } from "../data/workflow-archive-object-store.ts";

export type WorkflowArchiveRuntimeConfig = {
  readonly databaseUrl: string;
  readonly discoveryLimit: number;
  readonly intervalMs: number;
  readonly leaseMs: number;
  readonly maxRoots: number;
  readonly objectStore: ReturnType<typeof readWorkflowArchiveObjectStoreConfig>;
  readonly olderThanMs: number;
  readonly queryTimeoutMs: number;
  readonly retryBaseMs: number;
  readonly schema: string;
  readonly spoolDirectory?: string;
  readonly workflowDatabaseUrl: string;
};

export function readWorkflowArchiveRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowArchiveRuntimeConfig {
  const databaseUrl = required(environment.AGENT_DATABASE_URL, "AGENT_DATABASE_URL");
  const workflowDatabaseUrl = required(environment.WORKFLOW_POSTGRES_URL, "WORKFLOW_POSTGRES_URL");
  const schema = environment.WORKFLOW_POSTGRES_SCHEMA?.trim() || "workflow";
  if (!/^[a-z_][a-z0-9_]*$/iu.test(schema)) throw new Error("WORKFLOW_POSTGRES_SCHEMA is invalid.");
  const maxRoots = boundedInteger(environment.WORKFLOW_ARCHIVE_MAX_ROOTS, 2, 1, 100);
  const discoveryLimit = boundedInteger(
    environment.WORKFLOW_ARCHIVE_DISCOVERY_LIMIT,
    Math.max(100, maxRoots * 4),
    maxRoots,
    10_000,
  );
  return {
    databaseUrl,
    discoveryLimit,
    intervalMs: boundedInteger(environment.WORKFLOW_ARCHIVE_INTERVAL_MS, 15 * 60_000, 10_000, 86_400_000),
    leaseMs: boundedInteger(environment.WORKFLOW_ARCHIVE_LEASE_MS, 60 * 60_000, 60_000, 86_400_000),
    maxRoots,
    objectStore: readWorkflowArchiveObjectStoreConfig(environment),
    olderThanMs: boundedInteger(environment.WORKFLOW_ARCHIVE_OLDER_THAN_MS, 7 * 24 * 60 * 60_000, 60_000, 10 * 365 * 24 * 60 * 60_000),
    queryTimeoutMs: boundedInteger(environment.WORKFLOW_ARCHIVE_QUERY_TIMEOUT_MS, 15_000, 1_000, 300_000),
    retryBaseMs: boundedInteger(environment.WORKFLOW_ARCHIVE_RETRY_BASE_MS, 5 * 60_000, 1_000, 86_400_000),
    schema,
    ...(environment.WORKFLOW_ARCHIVE_SPOOL_DIRECTORY?.trim()
      ? { spoolDirectory: environment.WORKFLOW_ARCHIVE_SPOOL_DIRECTORY.trim() }
      : {}),
    workflowDatabaseUrl,
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Workflow archive configuration must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}
