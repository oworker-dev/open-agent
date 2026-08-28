import { Pool } from "pg";

export type AgentDatabaseConfig = {
  readonly connectionString: string;
  /** Maximum number of non-terminal AgentRuns allowed across this service. 0 disables the gate (development only). */
  readonly maxActiveRuns?: number;
  /** Maximum number of non-terminal AgentRuns allowed for one tenant. 0 disables the gate (development only). */
  readonly maxActiveRunsPerTenant?: number;
  /** Abort a pool checkout when PostgreSQL cannot provide a connection in time. */
  readonly connectionTimeoutMillis?: number;
  /** Release idle clients so a quiet replica does not retain all database slots. */
  readonly idleTimeoutMillis?: number;
  /** Abort a PostgreSQL query that is blocked or slow beyond this bound. */
  readonly queryTimeoutMillis?: number;
  readonly maxPoolSize: number;
  readonly schema: string;
};

const DEFAULT_SCHEMA = "open_agent";
export const DEFAULT_AGENT_DATABASE_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_AGENT_DATABASE_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_AGENT_DATABASE_QUERY_TIMEOUT_MS = 15_000;
const globalAgentDatabase = globalThis as typeof globalThis & {
  __openAgentDatabasePools?: Map<string, Pool>;
};

export function readAgentDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentDatabaseConfig | undefined {
  const connectionString = environment.AGENT_DATABASE_URL?.trim();
  if (!connectionString) return undefined;

  const schema = environment.AGENT_DATABASE_SCHEMA?.trim() || DEFAULT_SCHEMA;
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error("AGENT_DATABASE_SCHEMA must be a valid PostgreSQL identifier.");
  }

  const configuredMax = environment.AGENT_DATABASE_MAX_POOL_SIZE?.trim();
  const maxPoolSize = configuredMax ? Number(configuredMax) : 10;
  if (!Number.isInteger(maxPoolSize) || maxPoolSize < 1 || maxPoolSize > 100) {
    throw new Error("AGENT_DATABASE_MAX_POOL_SIZE must be an integer from 1 to 100.");
  }

  const connectionTimeoutMillis = readBoundedMillis(
    environment.AGENT_DATABASE_CONNECTION_TIMEOUT_MS,
    "AGENT_DATABASE_CONNECTION_TIMEOUT_MS",
    DEFAULT_AGENT_DATABASE_CONNECTION_TIMEOUT_MS,
  );
  const idleTimeoutMillis = readBoundedMillis(
    environment.AGENT_DATABASE_IDLE_TIMEOUT_MS,
    "AGENT_DATABASE_IDLE_TIMEOUT_MS",
    DEFAULT_AGENT_DATABASE_IDLE_TIMEOUT_MS,
  );
  const queryTimeoutMillis = readBoundedMillis(
    environment.AGENT_DATABASE_QUERY_TIMEOUT_MS,
    "AGENT_DATABASE_QUERY_TIMEOUT_MS",
    DEFAULT_AGENT_DATABASE_QUERY_TIMEOUT_MS,
  );

  return {
    connectionString,
    maxActiveRuns: readOptionalBoundedLimit(environment.AGENT_MAX_ACTIVE_RUNS_TOTAL, "AGENT_MAX_ACTIVE_RUNS_TOTAL"),
    maxActiveRunsPerTenant: readOptionalBoundedLimit(environment.AGENT_MAX_ACTIVE_RUNS_PER_TENANT, "AGENT_MAX_ACTIVE_RUNS_PER_TENANT"),
    connectionTimeoutMillis,
    idleTimeoutMillis,
    queryTimeoutMillis,
    maxPoolSize,
    schema,
  };
}

function readOptionalBoundedLimit(value: string | undefined, name: string): number {
  if (!value?.trim()) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(`${name} must be an integer from 0 to 10000.`);
  }
  return parsed;
}

function readBoundedMillis(value: string | undefined, name: string, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 300_000) {
    throw new Error(`${name} must be an integer from 100 to 300000 milliseconds.`);
  }
  return parsed;
}

export function getAgentDatabasePool(config: AgentDatabaseConfig): Pool {
  const connectionTimeoutMillis = config.connectionTimeoutMillis ?? DEFAULT_AGENT_DATABASE_CONNECTION_TIMEOUT_MS;
  const idleTimeoutMillis = config.idleTimeoutMillis ?? DEFAULT_AGENT_DATABASE_IDLE_TIMEOUT_MS;
  const queryTimeoutMillis = config.queryTimeoutMillis ?? DEFAULT_AGENT_DATABASE_QUERY_TIMEOUT_MS;
  const key = `${config.connectionString}\u0000${config.maxPoolSize}\u0000${connectionTimeoutMillis}\u0000${idleTimeoutMillis}\u0000${queryTimeoutMillis}`;
  const pools = globalAgentDatabase.__openAgentDatabasePools ??= new Map();
  const existing = pools.get(key);
  if (existing) return existing;

  const pool = new Pool({
    application_name: "open-agent",
    connectionString: config.connectionString,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    query_timeout: queryTimeoutMillis,
    max: config.maxPoolSize,
  });
  pools.set(key, pool);
  return pool;
}

export async function closeAgentDatabasePools(): Promise<void> {
  const pools = globalAgentDatabase.__openAgentDatabasePools;
  if (!pools) return;
  globalAgentDatabase.__openAgentDatabasePools = new Map();
  await Promise.all([...pools.values()].map((pool) => pool.end()));
}

/** Read-only pool counters used by the protected capacity diagnostics route. */
export function getAgentDatabasePoolStats(): readonly {
  readonly key: string;
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}[] {
  const pools = globalAgentDatabase.__openAgentDatabasePools;
  if (!pools) return [];
  return [...pools.entries()].map(([key, pool]) => ({
    key: key.replace(/^[^\u0000]+\u0000/u, "<redacted>\u0000"),
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  }));
}

export type AgentRunAdmissionStats = {
  readonly available: true;
  readonly activeRuns: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly oldestActiveAt: string | null;
};

/**
 * Read low-cardinality AgentRun admission counters for protected diagnostics.
 * This intentionally returns no tenant ids, prompts, or result payloads. The
 * query uses the partial status index and is safe to sample during load tests.
 */
export async function getAgentRunAdmissionStats(
  config: AgentDatabaseConfig,
  pool: Pick<Pool, "query"> = getAgentDatabasePool(config),
): Promise<AgentRunAdmissionStats> {
  const table = `${quoteIdentifier(config.schema)}."agent_runs"`;
  const result = await pool.query<{
    status: string;
    count: string;
    oldestActiveAt: Date | string | null;
  }>(
    `select status,
            count(*)::text as count,
            min(updated_at) as "oldestActiveAt"
       from ${table}
      where status in ('submitting', 'running', 'waiting-input', 'waiting-authorization')
      group by status`,
  );
  const byStatus: Record<string, number> = {
    submitting: 0,
    running: 0,
    "waiting-input": 0,
    "waiting-authorization": 0,
  };
  let activeRuns = 0;
  let oldestActiveAt: string | null = null;
  for (const row of result.rows) {
    if (!(row.status in byStatus)) throw new Error("Invalid AgentRun admission status.");
    const count = parseCount(row.count);
    byStatus[row.status] = count;
    activeRuns += count;
    if (row.oldestActiveAt) {
      const timestamp = row.oldestActiveAt instanceof Date
        ? row.oldestActiveAt.toISOString()
        : new Date(row.oldestActiveAt).toISOString();
      if (!oldestActiveAt || timestamp < oldestActiveAt) oldestActiveAt = timestamp;
    }
  }
  return {
    available: true,
    activeRuns,
    byStatus,
    oldestActiveAt,
  };
}

function parseCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid AgentRun admission count.");
  return count;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error("Unsafe PostgreSQL identifier.");
  }
  return `"${identifier}"`;
}
