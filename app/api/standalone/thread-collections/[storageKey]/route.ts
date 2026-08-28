import type { AgentThreadCollection } from "@oworker/open-agent-ui/agent-workspace";
import { AGENT_THREAD_STORAGE_VERSION } from "@oworker/open-agent-ui/agent-workspace";
import { createPostgresThreadCollectionStoreFromEnvironment, type ThreadCollectionPatchRecord } from "@/server/data/thread-collection-store";
import { authenticateStandaloneRequest } from "@/server/http/standalone-request-auth";
import {
  applyThreadCollectionPatch,
  parseStrictThreadCollection,
  parseThreadCollectionPatch,
  summarizeThreadCollection,
} from "@/server/http/thread-collection-contract";

export const runtime = "nodejs";

// PUT is retained only for legacy full-snapshot clients. Normal Agent
// checkpoints use PATCH event deltas and never scale with transcript size.
const MAX_LEGACY_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const DEFAULT_EVENT_WINDOW = 256;
const MAX_EVENT_WINDOW = 1_000;
const store = createPostgresThreadCollectionStoreFromEnvironment<AgentThreadCollection>();

type RouteContext = { readonly params: Promise<{ readonly storageKey: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!store) return databaseUnavailable(authenticated.setCookie);

  const { storageKey } = await context.params;
  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");
  const indexView = url.searchParams.get("view") === "index";
  if (threadId && url.searchParams.get("eventWindow") === "1" && store.loadThreadWindow) {
    const window = parseEventWindow(url);
    if (!window) return problem(400, "invalid_event_window", "The event window cursor or limit is invalid.", authenticated.setCookie);
    const record = await store.loadThreadWindow(
      authenticated.identity.tenantId,
      authenticated.identity.principalId,
      storageKey,
      threadId,
      window,
    );
    return Response.json(
      { eventWindow: record?.window ?? null, revision: record?.revision ?? 0, thread: record?.thread ?? null },
      { headers: responseHeaders(record?.revision ?? 0, authenticated.setCookie) },
    );
  }
  if (threadId && !indexView && store.loadThread) {
    const record = await store.loadThread(
      authenticated.identity.tenantId,
      authenticated.identity.principalId,
      storageKey,
      threadId,
    );
    return Response.json(
      { thread: record?.thread ?? null, revision: record?.revision ?? 0 },
      { headers: responseHeaders(record?.revision ?? 0, authenticated.setCookie) },
    );
  }
  const record = indexView && store.loadIndex
    ? await store.loadIndex(
        authenticated.identity.tenantId,
        authenticated.identity.principalId,
        storageKey,
      )
    : await store.load(
        authenticated.identity.tenantId,
        authenticated.identity.principalId,
        storageKey,
      );
  const collection = record?.collection ?? { threads: [], version: 2 };
  const revision = record?.revision ?? 0;
  if (matchesRevision(request.headers.get("if-none-match"), revision)) {
    return new Response(null, {
      status: 304,
      headers: responseHeaders(revision, authenticated.setCookie),
    });
  }
  const responseCollection = indexView
    ? summarizeThreadCollection(collection, threadId ?? undefined)
    : collection;
  return Response.json(
    { collection: responseCollection, revision },
    { headers: responseHeaders(revision, authenticated.setCookie) },
  );
}

function parseEventWindow(url: URL): { before?: number; limit: number } | undefined {
  const rawBefore = url.searchParams.get("eventBefore");
  const rawLimit = url.searchParams.get("eventLimit");
  const limit = rawLimit === null ? DEFAULT_EVENT_WINDOW : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_WINDOW) return undefined;
  if (rawBefore === null || rawBefore === "") return { limit };
  const before = Number(rawBefore);
  if (!Number.isSafeInteger(before) || before < 0) return undefined;
  return { before, limit };
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const authenticated = authenticateStandaloneRequest(request);
  if (!store) return databaseUnavailable(authenticated.setCookie);

  const expectedRevision = parseExpectedRevision(request.headers.get("if-match"));
  if (expectedRevision === undefined) {
    return problem(428, "revision_required", "If-Match must contain the loaded collection revision.", authenticated.setCookie);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_LEGACY_SNAPSHOT_BYTES) {
    return problem(413, "collection_too_large", "The legacy thread snapshot exceeds 64 MiB.", authenticated.setCookie);
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
  if (Buffer.byteLength(serialized) > MAX_LEGACY_SNAPSHOT_BYTES) {
    return problem(413, "collection_too_large", "The legacy thread snapshot exceeds 64 MiB.", authenticated.setCookie);
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
  const input = await readJsonWithinLimit(request, authenticated.setCookie, MAX_PATCH_BYTES);
  if (input instanceof Response) return input;
  const patch = parseThreadCollectionPatch(input);
  if (!patch) {
    return problem(400, "invalid_collection_patch", "The thread collection patch is invalid.", authenticated.setCookie);
  }

  const { storageKey } = await context.params;
  const result = store.patch
    ? await store.patch(
        authenticated.identity.tenantId,
        authenticated.identity.principalId,
        storageKey,
        expectedRevision,
        patch as ThreadCollectionPatchRecord,
      )
    : await saveMetadataPatch(store, authenticated.identity.tenantId, authenticated.identity.principalId, storageKey, expectedRevision, patch);
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

async function saveMetadataPatch(
  threadStore: NonNullable<typeof store>,
  tenantId: string,
  principalId: string,
  storageKey: string,
  expectedRevision: number,
  patch: Parameters<typeof applyThreadCollectionPatch>[1],
) {
  const current = await threadStore.load(tenantId, principalId, storageKey);
  const collection = applyThreadCollectionPatch(
    current?.collection ?? { threads: [], version: AGENT_THREAD_STORAGE_VERSION },
    patch,
  );
  return await threadStore.save(tenantId, principalId, storageKey, expectedRevision, collection);
}

async function readJsonWithinLimit(request: Request, setCookie?: string, limit = MAX_PATCH_BYTES): Promise<unknown | Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limit) {
    return problem(413, "collection_too_large", `The thread collection patch exceeds ${Math.round(limit / 1024 / 1024)} MiB.`, setCookie);
  }
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > limit) {
      return problem(413, "collection_too_large", `The thread collection patch exceeds ${Math.round(limit / 1024 / 1024)} MiB.`, setCookie);
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

function matchesRevision(value: string | null, revision: number): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === `"${revision}"` || candidate === `W/"${revision}"`);
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
