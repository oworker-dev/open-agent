import { defineTool } from "eve/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { publicationOwnerFromAuth } from "../lib/session-ownership-auth.ts";
import { createArtifactToken, readPreviewTtlSeconds } from "../../lib/preview-token.ts";
import { createArtifactStoreFromEnvironment, MAX_ARTIFACT_BYTES } from "../../server/data/artifact-store.ts";
import { MAX_PUBLICATION_ALIAS_LENGTH, MAX_PUBLICATION_VERSION_LENGTH } from "../../server/data/publication-metadata.ts";

const publicationLabel = (maxLength: number) => z.string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Must not contain control characters")
  .optional();

export default defineTool({
  description:
    "Publish one completed file from /workspace as a temporary authenticated download or media preview URL. Use after generating and validating the artifact; never claim a file was delivered before this tool succeeds.",
  inputSchema: z.object({
    alias: publicationLabel(MAX_PUBLICATION_ALIAS_LENGTH).describe("Optional human-readable name for this published artifact."),
    path: z.string().trim().min(1).max(512),
    filename: z.string().trim().min(1).max(255).optional(),
    version: publicationLabel(MAX_PUBLICATION_VERSION_LENGTH).describe("Optional version label, such as v1 or 2026.09.05."),
  }),
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (!auth) throw new Error("Artifact publishing requires an authenticated Agent session.");
    const owner = publicationOwnerFromAuth(auth);
    const path = normalizeWorkspacePath(input.path);
    const sandbox = await ctx.getSandbox();
    const content = await sandbox.readBinaryFile({ path });
    if (!content || content.byteLength === 0) throw new Error("The artifact file is empty or unavailable.");
    if (content.byteLength > MAX_ARTIFACT_BYTES) throw new Error("The artifact exceeds the 25 MiB size limit.");
    const filename = input.filename ?? basename(path);
    const expiresAt = new Date(Date.now() + readPreviewTtlSeconds() * 1_000);
    const store = createArtifactStoreFromEnvironment();
    const record = await store.create({
      artifactId: `art_${randomUUID()}`,
      alias: input.alias,
      content,
      expiresAt,
      filename,
      mediaType: mediaTypeFor(filename),
      principalId: owner.principalId,
      sessionId: ctx.session.id,
      tenantId: owner.tenantId,
      version: input.version,
    });
    const token = createArtifactToken(record.artifactId, expiresAt);
    const baseUrl = process.env.AGENT_PUBLIC_BASE_URL?.trim();
    const pathPart = `/api/artifacts/${encodeURIComponent(record.artifactId)}?token=${encodeURIComponent(token)}`;
    const url = baseUrl ? new URL(pathPart, `${baseUrl.replace(/\/$/u, "")}/`).toString() : pathPart;
    return {
      artifactId: record.artifactId,
      ...(record.alias ? { alias: record.alias } : {}),
      bytes: record.totalBytes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      filename: record.filename,
      kind: "artifact",
      mediaType: record.mediaType,
      url,
      ...(record.version ? { version: record.version } : {}),
    };
  },
});

function normalizeWorkspacePath(value: string): string {
  const normalized = value.startsWith("/") ? value : `/workspace/${value}`;
  if (!normalized.startsWith("/workspace/") || normalized.split("/").includes("..")) {
    throw new Error("Artifact paths must stay inside /workspace.");
  }
  return normalized;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1) || "artifact.bin";
}

function mediaTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    csv: "text/csv; charset=utf-8",
    gif: "image/gif",
    html: "text/html; charset=utf-8",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json; charset=utf-8",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    zip: "application/zip",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}
