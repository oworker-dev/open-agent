import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalForMcpTool,
  authorizeMcpSession,
  createBrokeredMcpConnection,
  resolveBrokeredCredential,
} from "@oworker/open-agent-mcp-adapter";
import type { SessionContext } from "eve/tools";

const adapter = { id: "records", version: "1.0.0" } as const;

test("creates only a validated, compiled MCP connection surface", () => {
  const connection = createBrokeredMcpConnection({
    adapter,
    broker: {
      getServiceToken: () => "b".repeat(32),
      url: "https://broker.example/credentials",
    },
    connection: {
      description: "Reviewed record tools.",
      displayName: "Records",
      endpoint: "https://mcp.example/mcp",
      tools: {
        allow: ["read_record", "write_record"],
        requireApproval: ["write_record"],
      },
    },
  });

  assert.equal(connection.url, "https://mcp.example/mcp");
  assert.deepEqual(connection.tools, { allow: ["read_record", "write_record"] });
  assert.ok(typeof connection.approval === "function");
  assert.equal(connection.approval({ toolName: "gateway__read_record" } as never), "not-applicable");
  assert.equal(connection.approval({ toolName: "gateway__write_record" } as never), "user-approval");
  assert.throws(
    () => createBrokeredMcpConnection({
      adapter,
      broker: {
        getServiceToken: () => "b".repeat(32),
        url: "https://broker.example/credentials",
      },
      connection: {
        description: "Invalid approval surface.",
        displayName: "Records",
        endpoint: "https://mcp.example/mcp",
        tools: { allow: ["read_record"], requireApproval: ["delete_record"] },
      },
    }),
    /not present in the compiled allowlist/,
  );
});

test("pins MCP authorization to the initiating tenant and AgentRun grant", () => {
  const authorized = authorizeMcpSession(sessionContext({
    currentTenant: "tenant-a",
    initiatorGrant: [adapter],
    initiatorTenant: "tenant-a",
  }), adapter);
  assert.equal(authorized.subject.tenantId, "tenant-a");
  assert.equal(authorized.sessionId, "session-1");

  assert.throws(
    () => authorizeMcpSession(sessionContext({
      currentGrant: [adapter],
      currentTenant: "tenant-a",
      initiatorGrant: [],
      initiatorTenant: "tenant-a",
    }), adapter),
    /not granted to this AgentRun/,
  );
  assert.throws(
    () => authorizeMcpSession(sessionContext({
      currentTenant: "tenant-b",
      initiatorGrant: [adapter],
      initiatorTenant: "tenant-a",
    }), adapter),
    /does not match the session tenant/,
  );
});

test("approval matching requires the exact qualified MCP tool suffix", () => {
  assert.equal(approvalForMcpTool("gateway__publish", ["publish"]), "user-approval");
  assert.equal(approvalForMcpTool("gateway__publish_preview", ["publish"]), "not-applicable");
});

test("rejects unbounded Run policy before broker authorization", () => {
  assert.throws(
    () => authorizeMcpSession(sessionContext({
      currentTenant: "tenant-a",
      initiatorGrant: [],
      initiatorPolicy: JSON.stringify({
        mcpConnections: Array.from({ length: 257 }, () => adapter),
      }),
      initiatorTenant: "tenant-a",
    }), adapter),
    /AgentRun MCP policy is invalid/,
  );
});

test("stops reading an oversized credential broker response", async (context) => {
  let cancelled = false;
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new Uint8Array(10_000));
      controller.enqueue(new Uint8Array(10_000));
    },
  }), { status: 200 }));

  await assert.rejects(
    resolveBrokeredCredential({
      getServiceToken: () => "b".repeat(32),
      request: {
        adapter,
        contractVersion: "0.1.0",
        sessionId: "session-1",
        subject: {
          actorType: "user",
          principalId: "user-1",
          tenantId: "tenant-a",
        },
      },
      timeoutMs: 1_000,
      url: "https://broker.example/credentials",
    }),
    /MCP credential could not be authorized/,
  );
  assert.equal(cancelled, true);
});

test("sanitizes a credential broker response stream failure", async (context) => {
  const brokerFailure = new Error("private broker transport details");
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) {
      controller.error(brokerFailure);
    },
  }), { status: 200 }));

  await assert.rejects(
    resolveBrokeredCredential({
      getServiceToken: () => "b".repeat(32),
      request: {
        adapter,
        contractVersion: "0.1.0",
        sessionId: "session-1",
        subject: {
          actorType: "user",
          principalId: "user-1",
          tenantId: "tenant-a",
        },
      },
      timeoutMs: 1_000,
      url: "https://broker.example/credentials",
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch((error as Error).message, /private broker transport details/);
      return true;
    },
  );
});

function sessionContext(input: {
  readonly currentGrant?: readonly typeof adapter[];
  readonly currentTenant: string;
  readonly initiatorGrant: readonly typeof adapter[];
  readonly initiatorPolicy?: string;
  readonly initiatorTenant: string;
}): SessionContext {
  const principal = (
    tenantId: string,
    grant: readonly typeof adapter[],
    principalId: string,
    policy?: string,
  ) => ({
    attributes: {
      actorType: "user",
      agentRunPolicy: policy ?? JSON.stringify({ mcpConnections: grant }),
      tenantId,
    },
    authenticator: "test",
    principalId,
    principalType: "user" as const,
  });
  return {
    session: {
      auth: {
        current: principal(input.currentTenant, input.currentGrant ?? [], "current-user"),
        initiator: principal(
          input.initiatorTenant,
          input.initiatorGrant,
          "initiator-user",
          input.initiatorPolicy,
        ),
      },
      id: "session-1",
      turn: { id: "turn-1" },
    },
  } as unknown as SessionContext;
}
