import type {
  AgentAssetUpload,
  AgentAssetUploadAdapter,
  AgentWorkspaceClientConfig,
} from "./contracts.js";
import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

type UploadSession = {
  readonly assetId: string;
  readonly chunkSizeBytes: number;
  readonly filename: string;
  readonly mediaType: string;
  readonly partCount: number;
  readonly sizeBytes: number;
  readonly status?: "failed" | "ready" | "uploading";
  readonly transferStrategy?: "direct" | "proxy";
  readonly uploadId: string;
};

type UploadTarget = {
  readonly expiresAt: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: "PUT";
  readonly partNumber: number;
  readonly url: string;
};

type UploadedPart = { readonly etag?: string; readonly partNumber: number; readonly sizeBytes: number };

const DIRECT_UPLOAD_CONCURRENCY = 3;
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024;

/** assistant-ui adapter that uploads on add so progress is visible in Composer. */
export function createBrowserAttachmentAdapter(
  uploadAdapter: AgentAssetUploadAdapter,
  sessionId: () => string | undefined,
): AttachmentAdapter {
  const uploaded = new Map<string, AgentAssetUpload>();
  const controllers = new Map<string, AbortController>();
  return {
    accept: "*",
    async *add({ file }): AsyncGenerator<PendingAttachment, void> {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must be 10 GiB or smaller.");
      const id = crypto.randomUUID();
      const base = {
        contentType: file.type || "application/octet-stream",
        file,
        id,
        name: file.name,
        type: file.type.startsWith("image/") ? "image" as const : "file" as const,
      };
      const controller = new AbortController();
      const progress = createProgressQueue();
      controllers.set(id, controller);
      yield { ...base, status: { progress: 0, reason: "uploading", type: "running" } };
      let result: { readonly asset?: AgentAssetUpload; readonly error?: unknown } | undefined;
      void uploadAdapter.upload({
        attachmentId: id,
        file,
        onProgress(value) {
          const percent = value.totalBytes <= 0 ? 0 : value.uploadedBytes / value.totalBytes * 100;
          progress.push(Math.max(0, Math.min(100, percent)));
        },
        sessionId: sessionId(),
        signal: controller.signal,
      }).then(
        (asset) => { result = { asset }; progress.close(); },
        (error: unknown) => { result = { error }; progress.close(); },
      );
      for (;;) {
        const next = await progress.next();
        if (next === undefined) break;
        yield { ...base, status: { progress: next, reason: "uploading", type: "running" } };
      }
      controllers.delete(id);
      if (!result?.asset) {
        yield {
          ...base,
          status: {
            message: result?.error instanceof Error ? result.error.message : "Asset upload failed.",
            reason: "error",
            type: "incomplete",
          },
        };
        return;
      }
      uploaded.set(id, result.asset);
      yield { ...base, status: { reason: "composer-send", type: "requires-action" } };
    },
    async remove(attachment: Attachment) {
      controllers.get(attachment.id)?.abort();
      controllers.delete(attachment.id);
      const asset = uploaded.get(attachment.id);
      uploaded.delete(attachment.id);
      if (asset) await uploadAdapter.remove?.(asset);
    },
    async send(attachment): Promise<CompleteAttachment> {
      const asset = uploaded.get(attachment.id);
      if (!asset) throw new Error("The attachment has not finished uploading.");
      uploaded.delete(attachment.id);
      return {
        ...attachment,
        content: [{
          data: `asset://${asset.assetId}`,
          filename: asset.filename,
          mimeType: asset.mediaType,
          type: "file",
        }],
        status: { type: "complete" },
      };
    },
  };
}

/** Default host-neutral HTTP implementation used by the reference client. */
export function createHttpAgentAssetUploadAdapter(
  config: AgentWorkspaceClientConfig | undefined,
): AgentAssetUploadAdapter {
  return {
    async upload({ file, onProgress, sessionId, signal }) {
      const ownerSessionId = sessionId ?? `browser-${crypto.randomUUID()}`;
      let uploadId: string | undefined;
      try {
        const initialized = await controlRequest(config, "/api/assets/uploads", {
          body: JSON.stringify({
            filename: file.name,
            mediaType: file.type || "application/octet-stream",
            sessionId: ownerSessionId,
            sizeBytes: file.size,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal,
        });
        const upload = requireUploadSession((await readJson(initialized)).upload);
        uploadId = upload.uploadId;
        const parts = upload.transferStrategy === "direct"
          ? await uploadDirectParts(config, upload, file, signal, onProgress)
          : await uploadProxyParts(config, upload, file, signal, onProgress);
        const asset = await completeUpload(config, upload, parts, signal);
        onProgress({ totalBytes: file.size, uploadedBytes: file.size });
        return asset;
      } catch (error) {
        if (uploadId) {
          await controlRequest(config, `/api/assets/uploads/${encodeURIComponent(uploadId)}`, {
            method: "DELETE",
          }).catch(() => undefined);
        }
        throw error;
      }
    },
    async remove(asset) {
      await controlRequest(config, `/api/assets/${encodeURIComponent(asset.assetId)}`, {
        method: "DELETE",
      });
    },
  };
}

async function completeUpload(
  config: AgentWorkspaceClientConfig | undefined,
  upload: UploadSession,
  parts: readonly UploadedPart[],
  signal: AbortSignal,
): Promise<AgentAssetUpload> {
  try {
    const completed = await withUploadRetries(
      () => controlRequest(config, `/api/assets/uploads/${encodeURIComponent(upload.uploadId)}/complete`, {
        body: JSON.stringify({ parts }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal,
      }),
      signal,
    );
    return requireUploadedAsset((await readJson(completed)).asset);
  } catch (error) {
    // A lost completion response can race the retry with the server's durable
    // completion lease. Reconcile that 409 from authoritative upload state
    // instead of reporting a failed attachment that is already committing.
    if (!(error instanceof UploadHttpError) || error.status !== 409) throw error;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await abortableDelay(500, signal);
      const inspected = await withUploadRetries(
        () => controlRequest(config, `/api/assets/uploads/${encodeURIComponent(upload.uploadId)}`, { method: "GET", signal }),
        signal,
      );
      const current = requireUploadSession((await readJson(inspected)).upload);
      if (current.status === "ready") {
        return {
          assetId: current.assetId,
          filename: current.filename,
          mediaType: current.mediaType,
          sizeBytes: current.sizeBytes,
        };
      }
      if (current.status === "failed") throw new Error("The object store could not complete the asset upload.");
    }
    throw new Error("The asset upload is still being reconciled. Retry after the current completion lease settles.");
  }
}

async function uploadDirectParts(
  config: AgentWorkspaceClientConfig | undefined,
  upload: UploadSession,
  file: File,
  signal: AbortSignal,
  onProgress: (progress: { readonly totalBytes: number; readonly uploadedBytes: number }) => void,
): Promise<readonly UploadedPart[]> {
  const progressByPart = new Map<number, number>();
  const parts = new Array<UploadedPart>(upload.partCount);
  let nextPartNumber = 1;
  const report = () => onProgress({
    totalBytes: file.size,
    uploadedBytes: Math.min(file.size, [...progressByPart.values()].reduce((total, value) => total + value, 0)),
  });
  report();

  const worker = async () => {
    for (;;) {
      const partNumber = nextPartNumber;
      nextPartNumber += 1;
      if (partNumber > upload.partCount) return;
      const start = (partNumber - 1) * upload.chunkSizeBytes;
      const end = Math.min(file.size, start + upload.chunkSizeBytes);
      const content = file.slice(start, end);
      const sizeBytes = end - start;
      const targetResponse = await withUploadRetries(
        () => controlRequest(config, partPath(upload.uploadId, partNumber), {
          body: JSON.stringify({ action: "sign", sizeBytes }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal,
        }),
        signal,
      );
      const target = requireUploadTarget((await readJson(targetResponse)).target, partNumber);
      const etag = await withUploadRetries(
        () => uploadPartToTarget(target, content, signal, (loaded) => {
          progressByPart.set(partNumber, Math.max(progressByPart.get(partNumber) ?? 0, loaded));
          report();
        }),
        signal,
      );
      const acknowledged = await withUploadRetries(
        () => controlRequest(config, partPath(upload.uploadId, partNumber), {
          body: JSON.stringify({ action: "acknowledge", etag, sizeBytes }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal,
        }),
        signal,
      );
      const part = requireUploadedPart((await readJson(acknowledged)).part, partNumber, sizeBytes);
      parts[partNumber - 1] = part;
      progressByPart.set(partNumber, sizeBytes);
      report();
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(DIRECT_UPLOAD_CONCURRENCY, upload.partCount) },
    () => worker(),
  ));
  return parts;
}

async function uploadProxyParts(
  config: AgentWorkspaceClientConfig | undefined,
  upload: UploadSession,
  file: File,
  signal: AbortSignal,
  onProgress: (progress: { readonly totalBytes: number; readonly uploadedBytes: number }) => void,
): Promise<readonly UploadedPart[]> {
  const parts: UploadedPart[] = [];
  onProgress({ totalBytes: file.size, uploadedBytes: 0 });
  for (let partNumber = 1, offset = 0; offset < file.size; partNumber += 1) {
    const end = Math.min(file.size, offset + upload.chunkSizeBytes);
    const response = await withUploadRetries(
      () => controlRequest(config, partPath(upload.uploadId, partNumber), {
        body: file.slice(offset, end),
        headers: { "content-type": "application/octet-stream" },
        method: "PUT",
        signal,
      }),
      signal,
    );
    parts.push(requireUploadedPart((await readJson(response)).part, partNumber, end - offset));
    offset = end;
    onProgress({ totalBytes: file.size, uploadedBytes: offset });
  }
  return parts;
}

function uploadPartToTarget(
  target: UploadTarget,
  content: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open(target.method, target.url, true);
    for (const [name, value] of Object.entries(target.headers ?? {})) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => onProgress(Math.min(content.size, event.loaded));
    request.onerror = () => reject(new RetryableUploadError("The object-store upload connection failed."));
    request.onabort = () => reject(new DOMException("The asset upload was cancelled.", "AbortError"));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new UploadHttpError(request.status, `Object-store upload failed (${request.status}).`));
        return;
      }
      const etag = request.getResponseHeader("etag")?.trim();
      if (!etag) {
        reject(new Error("The object store did not expose ETag. Configure bucket CORS to expose the ETag response header."));
        return;
      }
      onProgress(content.size);
      resolve(etag);
    };
    signal.addEventListener("abort", abort, { once: true });
    request.onloadend = () => signal.removeEventListener("abort", abort);
    request.send(content);
  });
}

async function withUploadRetries<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableUploadError(error) || attempt === MAX_UPLOAD_ATTEMPTS - 1) break;
      await abortableDelay(300 * 2 ** attempt, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Asset upload failed after retries.");
}

async function controlRequest(
  config: AgentWorkspaceClientConfig | undefined,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = { ...(await resolveClientHeaders(config)), ...(init.headers ?? {}) };
  const base = config?.host || (typeof window !== "undefined" ? window.location.origin : "http://localhost");
  const response = await fetch(new URL(path, base).toString(), { ...init, credentials: "include", headers });
  if (!response.ok) throw new UploadHttpError(response.status, `Asset request failed (${response.status}).`);
  return response;
}

async function resolveClientHeaders(config: AgentWorkspaceClientConfig | undefined): Promise<Readonly<Record<string, string>>> {
  const resolved = typeof config?.headers === "function" ? await config.headers() : config?.headers;
  if (config?.auth && "bearer" in config.auth) {
    const token = typeof config.auth.bearer === "function" ? await config.auth.bearer() : config.auth.bearer;
    return { ...(resolved ?? {}), authorization: `Bearer ${token}` };
  }
  return resolved ?? {};
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new Error("The asset service returned invalid JSON.");
  }
}

function requireUploadSession(value: unknown): UploadSession {
  if (!value || typeof value !== "object") throw new Error("The asset service returned no upload session.");
  const upload = value as Partial<UploadSession>;
  if (
    typeof upload.assetId !== "string" || typeof upload.uploadId !== "string"
    || !Number.isSafeInteger(upload.chunkSizeBytes) || Number(upload.chunkSizeBytes) <= 0
    || !Number.isSafeInteger(upload.partCount) || Number(upload.partCount) <= 0
    || typeof upload.filename !== "string"
    || typeof upload.mediaType !== "string"
    || !Number.isSafeInteger(upload.sizeBytes)
  ) throw new Error("The asset service returned an invalid upload session.");
  return upload as UploadSession;
}

function requireUploadTarget(value: unknown, partNumber: number): UploadTarget {
  if (!value || typeof value !== "object") throw new Error("The asset service returned no direct upload target.");
  const target = value as Partial<UploadTarget>;
  if (target.method !== "PUT" || target.partNumber !== partNumber || typeof target.url !== "string" || !/^https?:\/\//u.test(target.url)) {
    throw new Error("The asset service returned an invalid direct upload target.");
  }
  return target as UploadTarget;
}

function requireUploadedPart(value: unknown, partNumber: number, sizeBytes: number): UploadedPart {
  if (!value || typeof value !== "object") throw new Error(`Asset part ${partNumber} was not acknowledged.`);
  const part = value as Partial<UploadedPart>;
  if (part.partNumber !== partNumber || part.sizeBytes !== sizeBytes) throw new Error(`Asset part ${partNumber} acknowledgement is invalid.`);
  return part as UploadedPart;
}

function requireUploadedAsset(value: unknown): AgentAssetUpload {
  if (!value || typeof value !== "object") throw new Error("The asset service returned no completed asset.");
  const asset = value as Partial<AgentAssetUpload>;
  if (
    typeof asset.assetId !== "string" || typeof asset.filename !== "string"
    || typeof asset.mediaType !== "string" || !Number.isSafeInteger(asset.sizeBytes)
  ) throw new Error("The asset service returned invalid completed asset metadata.");
  return asset as AgentAssetUpload;
}

function partPath(uploadId: string, partNumber: number): string {
  return `/api/assets/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`;
}

function isRetryableUploadError(error: unknown): boolean {
  if (error instanceof RetryableUploadError) return true;
  if (error instanceof TypeError) return true;
  return error instanceof UploadHttpError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The asset upload was cancelled.", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

class UploadHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadHttpError";
    this.status = status;
  }
}

class RetryableUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableUploadError";
  }
}

function createProgressQueue() {
  const values: number[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    close() {
      closed = true;
      wake?.();
      wake = undefined;
    },
    async next(): Promise<number | undefined> {
      while (values.length === 0 && !closed) {
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
      return values.shift();
    },
    push(value: number) {
      if (closed) return;
      // Keep only the newest pending value; UI progress is a snapshot.
      values.splice(0, values.length, value);
      wake?.();
      wake = undefined;
    },
  };
}
