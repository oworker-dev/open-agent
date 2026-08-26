import type { Pool } from "pg";
import {
  getAgentDatabasePool,
  quoteIdentifier,
  readAgentDatabaseConfig,
  type AgentDatabaseConfig,
} from "./agent-database.ts";

export type AgentSessionOwner = {
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly tenantId: string;
};

export type AgentSessionOwnershipResult = "forbidden" | "missing" | "owned";

export interface AgentSessionOwnershipStore {
  claim(sessionId: string, owner: AgentSessionOwner): Promise<void>;
  verify(sessionId: string, owner: AgentSessionOwner): Promise<AgentSessionOwnershipResult>;
  waitForOwnership(
    sessionId: string,
    owner: AgentSessionOwner,
    options?: { readonly timeoutMs?: number },
  ): Promise<AgentSessionOwnershipResult>;
}

export function createPostgresSessionOwnershipStore(
  config: AgentDatabaseConfig,
): AgentSessionOwnershipStore {
  const pool = getAgentDatabasePool(config);
  const table = `${quoteIdentifier(config.schema)}."agent_session_owners"`;
  return postgresSessionOwnershipStore(pool, table);
}

export function createPostgresSessionOwnershipStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentSessionOwnershipStore | undefined {
  const config = readAgentDatabaseConfig(environment);
  return config ? createPostgresSessionOwnershipStore(config) : undefined;
}

function postgresSessionOwnershipStore(
  pool: Pool,
  table: string,
): AgentSessionOwnershipStore {
  const verify = async (
    sessionId: string,
    owner: AgentSessionOwner,
  ): Promise<AgentSessionOwnershipResult> => {
    const result = await pool.query<{
      issuer: string | null;
      principal_id: string;
      principal_type: string;
      tenant_id: string;
    }>(
      `select tenant_id, principal_id, principal_type, issuer from ${table} where session_id = $1`,
      [sessionId],
    );
    const current = result.rows[0];
    if (!current) return "missing";
    return current.tenant_id === owner.tenantId
      && current.principal_id === owner.principalId
      && current.principal_type === owner.principalType
      && (current.issuer ?? "") === (owner.issuer ?? "")
      ? "owned"
      : "forbidden";
  };

  return {
    async claim(sessionId, owner) {
      assertIdentifierValue(sessionId, "sessionId");
      assertOwner(owner);
      await pool.query(
        `insert into ${table}
          (session_id, tenant_id, principal_id, principal_type, issuer)
         values ($1, $2, $3, $4, $5)
         on conflict (session_id) do nothing`,
        [
          sessionId,
          owner.tenantId,
          owner.principalId,
          owner.principalType,
          owner.issuer ?? null,
        ],
      );
      const ownership = await verify(sessionId, owner);
      if (ownership !== "owned") {
        throw new Error("The Eve session is already owned by another authenticated principal.");
      }
    },
    verify,
    async waitForOwnership(sessionId, owner, options) {
      const timeoutMs = options?.timeoutMs ?? 2_000;
      const deadline = Date.now() + timeoutMs;
      let result = await verify(sessionId, owner);
      while (result === "missing" && Date.now() < deadline) {
        await delay(Math.min(50, Math.max(1, deadline - Date.now())));
        result = await verify(sessionId, owner);
      }
      return result;
    },
  };
}

function assertOwner(owner: AgentSessionOwner): void {
  assertIdentifierValue(owner.tenantId, "tenantId");
  assertIdentifierValue(owner.principalId, "principalId");
  assertIdentifierValue(owner.principalType, "principalType");
}

function assertIdentifierValue(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new Error(`${name} must contain between 1 and 512 characters.`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
