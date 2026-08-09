import { enqueueAgentMailboxHttpRequest } from "@/server/agent-mailbox/http";
import { createPostgresAgentMailboxStoreFromEnvironment } from "@/server/data/agent-mailbox-store";
import { createPostgresSessionOwnershipStoreFromEnvironment } from "@/server/data/session-ownership-store";
import { authenticateHostRequest } from "@/server/http/host-request-auth";

export const runtime = "nodejs";

const store = createPostgresAgentMailboxStoreFromEnvironment();
const ownershipStore = createPostgresSessionOwnershipStoreFromEnvironment();

export async function POST(request: Request): Promise<Response> {
  const authenticated = await authenticateHostRequest(request);
  if (!authenticated.ok) return authenticated.response;
  if (!store) {
    return Response.json(
      { code: "agent_database_unavailable", error: "AGENT_DATABASE_URL is not configured.", ok: false },
      { headers: { "cache-control": "no-store" }, status: 503 },
    );
  }
  return await enqueueAgentMailboxHttpRequest({
    owner: authenticated.identity,
    ...(ownershipStore ? { ownershipStore } : {}),
    request,
    runtimeConfig: authenticated.runtimeConfig,
    store,
  });
}
