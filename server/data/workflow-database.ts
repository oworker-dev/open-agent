import { Pool } from "pg";

export type WorkflowDatabaseConfig = {
  readonly connectionString: string;
  readonly schema: string;
  readonly maxPoolSize: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly queryTimeoutMillis: number;
};

export type WorkflowRuntimeStats = {
  readonly available: true;
  readonly activeRuns: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly oldestActiveAt: string | null;
};

const DEFAULT_SCHEMA = "workflow";
const DEFAULT_MAX_POOL_SIZE = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const globalWorkflowDatabase = globalThis as typeof globalThis & {
  __openAgentWorkflowDatabasePools?: Map<string, Pool>;
};

export function readWorkflowDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowDatabaseConfig | undefined {
  const connectionString = environment.WORKFLOW_POSTGRES_URL?.trim();
  if (!connectionString) return undefined;

  const schema = environment.WORKFLOW_POSTGRES_SCHEMA?.trim() || DEFAULT_SCHEMA;
  if (!/^[a-z_][a-z0-9_]*$/iu.test(schema)) {
    throw new Error("WORKFLOW_POSTGRES_SCHEMA must be a valid PostgreSQL identifier.");
  }

  const maxPoolSize = readBoundedInteger(
    environment.WORKFLOW_POSTGRES_MAX_POOL_SIZE,
    "WORKFLOW_POSTGRES_MAX_POOL_SIZE",
    DEFAULT_MAX_POOL_SIZE,
    1,
    100,
  );
  const connectionTimeoutMillis = readBoundedInteger(
    environment.WORKFLOW_POSTGRES_CONNECTION_TIMEOUT_MS,
    "WORKFLOW_POSTGRES_CONNECTION_TIMEOUT_MS",
    DEFAULT_CONNECTION_TIMEOUT_MS,
    100,
    300_000,
  );
  const idleTimeoutMillis = readBoundedInteger(
    environment.WORKFLOW_POSTGRES_IDLE_TIMEOUT_MS,
    "WORKFLOW_POSTGRES_IDLE_TIMEOUT_MS",
    DEFAULT_IDLE_TIMEOUT_MS,
    100,
    300_000,
  );
  const queryTimeoutMillis = readBoundedInteger(
    environment.WORKFLOW_POSTGRES_QUERY_TIMEOUT_MS,
    "WORKFLOW_POSTGRES_QUERY_TIMEOUT_MS",
    DEFAULT_QUERY_TIMEOUT_MS,
    100,
    300_000,
  );

  return {
    connectionString,
    schema,
    maxPoolSize,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    queryTimeoutMillis,
  };
}

export function getWorkflowDatabasePool(config: WorkflowDatabaseConfig): Pool {
  const key = `${config.connectionString}\u0000${config.schema}\u0000${config.maxPoolSize}\u0000${config.connectionTimeoutMillis}\u0000${config.idleTimeoutMillis}\u0000${config.queryTimeoutMillis}`;
  const pools = globalWorkflowDatabase.__openAgentWorkflowDatabasePools ??= new Map();
  const existing = pools.get(key);
  if (existing) return existing;

  const pool = new Pool({
    application_name: "open-agent-workflow-metrics",
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    // Keep the database-side timeout aligned with the client timeout so a
    // metrics or control-plane query cannot linger after its HTTP request is
    // gone.
    statement_timeout: config.queryTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    max: config.maxPoolSize,
  });
  pools.set(key, pool);
  return pool;
}

export async function getWorkflowRuntimeStats(
  config: WorkflowDatabaseConfig,
  pool: Pick<Pool, "query"> = getWorkflowDatabasePool(config),
): Promise<WorkflowRuntimeStats> {
  const table = `${quoteIdentifier(config.schema)}."workflow_runs"`;
  const result = await pool.query<{
    status: string;
    count: string;
    oldestActiveAt: Date | string | null;
  }>(
    `select status::text as status,
            count(*)::text as count,
            min(updated_at) filter (
              where status::text not in ('completed', 'failed', 'cancelled')
            ) as "oldestActiveAt"
       from ${table}
      group by status`,
  );

  const byStatus: Record<string, number> = {};
  let activeRuns = 0;
  let oldestActiveAt: string | null = null;
  for (const row of result.rows) {
    if (!row.status || row.status.length > 100) throw new Error("Invalid Workflow run status.");
    const count = parseCount(row.count);
    byStatus[row.status] = count;
    if (!isTerminalStatus(row.status)) {
      activeRuns += count;
      if (row.oldestActiveAt) {
        const timestamp = row.oldestActiveAt instanceof Date
          ? row.oldestActiveAt.toISOString()
          : new Date(row.oldestActiveAt).toISOString();
        if (!oldestActiveAt || timestamp < oldestActiveAt) oldestActiveAt = timestamp;
      }
    }
  }

  return { available: true, activeRuns, byStatus, oldestActiveAt };
}

export function getWorkflowDatabasePoolStats(): readonly {
  readonly key: string;
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}[] {
  const pools = globalWorkflowDatabase.__openAgentWorkflowDatabasePools;
  if (!pools) return [];
  return [...pools.entries()].map(([key, pool]) => ({
    key: key.replace(/^[^\u0000]+\u0000/u, "<redacted>\u0000"),
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  }));
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function parseCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid Workflow run count.");
  return count;
}

function readBoundedInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(identifier)) throw new Error("Unsafe PostgreSQL identifier.");
  return `"${identifier}"`;
}
