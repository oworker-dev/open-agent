import type { AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";
import { AGENT_THREAD_STORAGE_VERSION } from "@oworker/open-agent-ui/agent-workspace";
import { createPostgresThreadCollectionStoreFromEnvironment } from "@/server/data/thread-collection-store";
import { authenticateStandaloneRequest } from "@/server/http/standalone-request-auth";
import {
  applyThreadCollectionPatch,
  parseStrictThreadCollection,
  parseThreadCollectionPatch,
  summarizeThreadCollection,
} from "@/server/http/thread-collection-contract";

export const runtime = "nodejs";

const MAX_COLLECTION_BYTES = 5 * 1024 * 1024;
const store = createPostgresThreadCollectionStoreFromEnvironment<AgentThreadCollection>();

type RouteContext = { readonly params: Promise<{ readonly storageKey: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!store) return databaseUnavailable(authenticated.setCookie);

  const { storageKey } = await context.params;
  const record = await store.load(
    authenticated.identity.tenantId,
    authenticated.identity.principalId,
    storageKey,
  );
  const collection = record?.collection ?? { threads: [], version: 2 };
  const revision = record?.revision ?? 0;
  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");
  if (threadId && url.searchParams.get("view") !== "index") {
    return Response.json(
      { thread: collection.threads.find((thread) => thread.id === threadId) ?? null, revision },
      { headers: responseHeaders(revision, authenticated.setCookie) },
    );
  }
  const responseCollection = url.searchParams.get("view") === "index"
    ? summarizeThreadCollection(collection, threadId ?? undefined)
    : collection;
  return Response.json(
    { collection: responseCollection, revision },
    { headers: responseHeaders(revision, authenticated.setCookie) },
  );
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!store) return databaseUnavailable(authenticated.setCookie);

  const expectedRevision = parseExpectedRevision(request.headers.get("if-match"));
  if (expectedRevision === undefined) {
    return problem(428, "revision_required", "If-Match must contain the loaded collection revision.", authenticated.setCookie);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_COLLECTION_BYTES) {
    return problem(413, "collection_too_large", "The thread collection exceeds 5 MiB.", authenticated.setCookie);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON.", authenticated.setCookie);
  }
  if (!isRecord(input) || !("collection" in input)) {
    return problem(400, "invalid_collection", "The request must contain a thread collection.", authenticated.setCookie);
  }
  const serialized = JSON.stringify(input.collection);
  if (Buffer.byteLength(serialized) > MAX_COLLECTION_BYTES) {
    return problem(413, "collection_too_large", "The thread collection exceeds 5 MiB.", authenticated.setCookie);
  }
  const collection = parseStrictThreadCollection(input.collection);
  if (!collection) {
    return problem(400, "invalid_collection", "The thread collection does not match a supported storage version.", authenticated.setCookie);
  }

  const { storageKey } = await context.params;
  const result = await store.save(
    authenticated.identity.tenantId,
    authenticated.identity.principalId,
    storageKey,
    expectedRevision,
    collection,
  );
  if (result.status === "conflict") {
    return problem(
      409,
      "thread_collection_conflict",
      "The thread collection changed in another client.",
      authenticated.setCookie,
      responseHeaders(result.currentRevision),
    );
  }
  return Response.json(
    { revision: result.record.revision },
    { headers: responseHeaders(result.record.revision, authenticated.setCookie) },
  );
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!store) return databaseUnavailable(authenticated.setCookie);

  const expectedRevision = parseExpectedRevision(request.headers.get("if-match"));
  if (expectedRevision === undefined) {
    return problem(428, "revision_required", "If-Match must contain the loaded collection revision.", authenticated.setCookie);
  }
  const input = await readJsonWithinLimit(request, authenticated.setCookie);
  if (input instanceof Response) return input;
  const patch = parseThreadCollectionPatch(input);
  if (!patch) {
    return problem(400, "invalid_collection_patch", "The thread collection patch is invalid.", authenticated.setCookie);
  }

  const { storageKey } = await context.params;
  const current = await store.load(
    authenticated.identity.tenantId,
    authenticated.identity.principalId,
    storageKey,
  );
  const collection = applyThreadCollectionPatch(
    current?.collection ?? { threads: [], version: AGENT_THREAD_STORAGE_VERSION },
    patch,
  );
  const result = await store.save(
    authenticated.identity.tenantId,
    authenticated.identity.principalId,
    storageKey,
    expectedRevision,
    collection,
  );
  if (result.status === "conflict") {
    return problem(
      409,
      "thread_collection_conflict",
      "The thread collection changed in another client.",
      authenticated.setCookie,
      responseHeaders(result.currentRevision),
    );
  }
  return Response.json(
    { revision: result.record.revision },
    { headers: responseHeaders(result.record.revision, authenticated.setCookie) },
  );
}

async function readJsonWithinLimit(request: Request, setCookie?: string): Promise<unknown | Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_COLLECTION_BYTES) {
    return problem(413, "collection_too_large", "The thread collection patch exceeds 5 MiB.", setCookie);
  }
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_COLLECTION_BYTES) {
      return problem(413, "collection_too_large", "The thread collection patch exceeds 5 MiB.", setCookie);
    }
    return JSON.parse(text) as unknown;
  } catch {
    return problem(400, "invalid_json", "The request body must be valid JSON.", setCookie);
  }
}

function parseExpectedRevision(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = /^(?:W\/)?"(\d+)"$/.exec(value.trim());
  if (!match?.[1]) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

function responseHeaders(revision: number, setCookie?: string): HeadersInit {
  return {
    "cache-control": "no-store",
    etag: `"${revision}"`,
    ...(setCookie ? { "set-cookie": setCookie } : {}),
  };
}

function databaseUnavailable(setCookie?: string): Response {
  return problem(
    503,
    "agent_database_unavailable",
    "AGENT_DATABASE_URL is not configured for this deployment.",
    setCookie,
  );
}

function problem(
  status: number,
  code: string,
  message: string,
  setCookie?: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { code, error: message, ok: false },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(setCookie ? { "set-cookie": setCookie } : {}),
        ...headers,
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
