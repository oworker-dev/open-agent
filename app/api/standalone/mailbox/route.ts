import { readDeploymentAgentRuntimeConfig } from "@/lib/agent-runtime-config";
import { enqueueAgentMailboxHttpRequest } from "@/server/agent-mailbox/http";
import { createPostgresAgentMailboxStoreFromEnvironment } from "@/server/data/agent-mailbox-store";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { authenticateStandaloneRequest } from "@/server/http/standalone-request-auth";

export const runtime = "nodejs";

const store = createPostgresAgentMailboxStoreFromEnvironment();
const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();

export async function POST(request: Request): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!store) {
    return Response.json(
      { code: "agent_database_unavailable", error: "AGENT_DATABASE_URL is not configured.", ok: false },
      {
        headers: {
          "cache-control": "no-store",
          ...(authenticated.setCookie ? { "set-cookie": authenticated.setCookie } : {}),
        },
        status: 503,
      },
    );
  }
  return await enqueueAgentMailboxHttpRequest({
    owner: authenticated.identity,
    ...(ownershipStore ? { ownershipStore } : {}),
    request,
    runtimeConfig: readDeploymentAgentRuntimeConfig(),
    ...(authenticated.setCookie ? { setCookie: authenticated.setCookie } : {}),
    store,
  });
}
