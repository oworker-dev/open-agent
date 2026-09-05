import { defineTool } from "eve/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { publicationOwnerFromAuth } from "../lib/session-ownership-auth.ts";
import { createPreviewToken, readPreviewTtlSeconds } from "../../lib/preview-token.ts";
import { createPreviewStoreFromEnvironment } from "../../server/data/preview-store.ts";
import { MAX_PUBLICATION_ALIAS_LENGTH, MAX_PUBLICATION_VERSION_LENGTH } from "../../server/data/publication-metadata.ts";

const MAX_FILES = 1_000;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const publicationLabel = (maxLength: number) => z.string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Must not contain control characters")
  .optional();

export default defineTool({
  description:
    "Publish a completed static website from the session workspace and return a temporary browser preview URL. Build and validate the site first; use this only for the final user-visible result.",
  inputSchema: z.object({
    alias: publicationLabel(MAX_PUBLICATION_ALIAS_LENGTH).describe("Optional human-readable name for this website preview."),
    entrypoint: z.string().trim().min(1).max(256).default("index.html"),
    root: z.string().trim().min(1).max(256).default("."),
    version: publicationLabel(MAX_PUBLICATION_VERSION_LENGTH).describe("Optional version label, such as v1 or 2026.09.05."),
  }),
  async execute(input, ctx) {
    const store = createPreviewStoreFromEnvironment();
    const auth = ctx.session.auth.current;
    if (!auth) throw new Error("Preview publishing requires an authenticated Agent session.");
    const owner = publicationOwnerFromAuth(auth);
    const root = normalizeWorkspacePath(input.root);
    const entrypoint = normalizeRelativePath(input.entrypoint);
    const sandbox = await ctx.getSandbox();
    const listing = await sandbox.run({ command: `find ${shellQuote(root)} -type f -print0` });
    if (listing.exitCode !== 0) throw new Error(`Unable to enumerate preview files: ${listing.stderr}`);
    const paths = parseNullDelimited(listing.stdout);
    if (paths.length === 0) throw new Error("The preview root does not contain any files.");
    if (paths.length > MAX_FILES) throw new Error(`The preview contains more than ${MAX_FILES} files.`);

    const files = [];
    let totalBytes = 0;
    for (const absolutePath of paths) {
      const relativePath = relativeToRoot(root, absolutePath);
      const content = await readStream(await sandbox.readBinaryFile({ path: absolutePath }));
      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("The preview exceeds the 25 MiB size limit.");
      files.push({
        content,
        mediaType: mediaTypeFor(relativePath),
        path: relativePath,
      });
    }
    if (!files.some((file) => file.path === entrypoint)) {
      throw new Error(`The preview entrypoint "${entrypoint}" does not exist under the selected root.`);
    }

    const previewId = `prv_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + readPreviewTtlSeconds() * 1_000);
    const record = await store.create({
      alias: input.alias,
      entrypoint,
      expiresAt,
      files,
      previewId,
      principalId: owner.principalId,
      sessionId: ctx.session.id,
      tenantId: owner.tenantId,
      version: input.version,
    });
    const token = createPreviewToken(record.previewId, expiresAt);
    const baseUrl = process.env.AGENT_PUBLIC_BASE_URL?.trim();
    const path = `/api/previews/${encodeURIComponent(record.previewId)}/${encodePath(entrypoint)}?token=${encodeURIComponent(token)}`;
    const url = baseUrl ? new URL(path, `${baseUrl.replace(/\/$/u, "")}/`).toString() : path;
    return {
      ...(record.alias ? { alias: record.alias } : {}),
      bytes: record.totalBytes,
      createdAt: record.createdAt,
      entrypoint: record.entrypoint,
      expiresAt: record.expiresAt,
      fileCount: record.fileCount,
      kind: "website-preview",
      previewId: record.previewId,
      url,
      ...(record.version ? { version: record.version } : {}),
    };
  },
});

function normalizeWorkspacePath(value: string): string {
  const normalized = value === "." ? "/workspace" : value.startsWith("/") ? value : `/workspace/${value}`;
  if (!normalized.startsWith("/workspace") || normalized.split("/").includes("..")) {
    throw new Error("Preview root must stay inside /workspace.");
  }
  return normalized.replace(/\/+$/u, "") || "/workspace";
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.split("/").includes("..") || normalized.includes("\\")) {
    throw new Error("Preview paths must be relative and cannot escape the workspace.");
  }
  return normalized;
}

function relativeToRoot(root: string, absolutePath: string): string {
  const prefix = `${root}/`;
  if (!absolutePath.startsWith(prefix)) throw new Error("The sandbox returned a path outside the preview root.");
  return normalizeRelativePath(absolutePath.slice(prefix.length));
}

function parseNullDelimited(value: string): string[] {
  return value.split("\0").filter(Boolean).map((item) => item.trim());
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

async function readStream(value: Uint8Array | null): Promise<Uint8Array> {
  if (!value) throw new Error("The preview file disappeared before it could be published.");
  return value;
}

function mediaTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    css: "text/css; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    gif: "image/gif",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function encodePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}
