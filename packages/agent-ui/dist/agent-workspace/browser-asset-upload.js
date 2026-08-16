const DIRECT_UPLOAD_CONCURRENCY = 3;
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024;
export function createBrowserAttachmentAdapter(uploadAdapter, sessionId) {
    const uploaded = new Map();
    const controllers = new Map();
    return {
        accept: "*",
        async *add({ file }) {
            if (file.size > MAX_ATTACHMENT_BYTES)
                throw new Error("Attachments must be 10 GiB or smaller.");
            const id = crypto.randomUUID();
            const base = {
                contentType: file.type || "application/octet-stream",
                file,
                id,
                name: file.name,
                type: file.type.startsWith("image/") ? "image" : "file",
            };
            const controller = new AbortController();
            const progress = createProgressQueue();
            controllers.set(id, controller);
            yield { ...base, status: { progress: 0, reason: "uploading", type: "running" } };
            let result;
            void uploadAdapter.upload({
                attachmentId: id,
                file,
                onProgress(value) {
                    const percent = value.totalBytes <= 0 ? 0 : value.uploadedBytes / value.totalBytes * 100;
                    progress.push(Math.max(0, Math.min(100, percent)));
                },
                sessionId: sessionId(),
                signal: controller.signal,
            }).then((asset) => { result = { asset }; progress.close(); }, (error) => { result = { error }; progress.close(); });
            for (;;) {
                const next = await progress.next();
                if (next === undefined)
                    break;
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
        async remove(attachment) {
            controllers.get(attachment.id)?.abort();
            controllers.delete(attachment.id);
            const asset = uploaded.get(attachment.id);
            uploaded.delete(attachment.id);
            if (asset)
                await uploadAdapter.remove?.(asset);
        },
        async send(attachment) {
            const asset = uploaded.get(attachment.id);
            if (!asset)
                throw new Error("The attachment has not finished uploading.");
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
export function createHttpAgentAssetUploadAdapter(config) {
    return {
        async upload({ file, onProgress, sessionId, signal }) {
            const ownerSessionId = sessionId ?? `browser-${crypto.randomUUID()}`;
            let uploadId;
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
            }
            catch (error) {
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
async function completeUpload(config, upload, parts, signal) {
    try {
        const completed = await withUploadRetries(() => controlRequest(config, `/api/assets/uploads/${encodeURIComponent(upload.uploadId)}/complete`, {
            body: JSON.stringify({ parts }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal,
        }), signal);
        return requireUploadedAsset((await readJson(completed)).asset);
    }
    catch (error) {
        if (!(error instanceof UploadHttpError) || error.status !== 409)
            throw error;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            await abortableDelay(500, signal);
            const inspected = await withUploadRetries(() => controlRequest(config, `/api/assets/uploads/${encodeURIComponent(upload.uploadId)}`, { method: "GET", signal }), signal);
            const current = requireUploadSession((await readJson(inspected)).upload);
            if (current.status === "ready") {
                return {
                    assetId: current.assetId,
                    filename: current.filename,
                    mediaType: current.mediaType,
                    sizeBytes: current.sizeBytes,
                };
            }
            if (current.status === "failed")
                throw new Error("The object store could not complete the asset upload.");
        }
        throw new Error("The asset upload is still being reconciled. Retry after the current completion lease settles.");
    }
}
async function uploadDirectParts(config, upload, file, signal, onProgress) {
    const progressByPart = new Map();
    const parts = new Array(upload.partCount);
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
            if (partNumber > upload.partCount)
                return;
            const start = (partNumber - 1) * upload.chunkSizeBytes;
            const end = Math.min(file.size, start + upload.chunkSizeBytes);
            const content = file.slice(start, end);
            const sizeBytes = end - start;
            const targetResponse = await withUploadRetries(() => controlRequest(config, partPath(upload.uploadId, partNumber), {
                body: JSON.stringify({ action: "sign", sizeBytes }),
                headers: { "content-type": "application/json" },
                method: "POST",
                signal,
            }), signal);
            const target = requireUploadTarget((await readJson(targetResponse)).target, partNumber);
            const etag = await withUploadRetries(() => uploadPartToTarget(target, content, signal, (loaded) => {
                progressByPart.set(partNumber, Math.max(progressByPart.get(partNumber) ?? 0, loaded));
                report();
            }), signal);
            const acknowledged = await withUploadRetries(() => controlRequest(config, partPath(upload.uploadId, partNumber), {
                body: JSON.stringify({ action: "acknowledge", etag, sizeBytes }),
                headers: { "content-type": "application/json" },
                method: "POST",
                signal,
            }), signal);
            const part = requireUploadedPart((await readJson(acknowledged)).part, partNumber, sizeBytes);
            parts[partNumber - 1] = part;
            progressByPart.set(partNumber, sizeBytes);
            report();
        }
    };
    await Promise.all(Array.from({ length: Math.min(DIRECT_UPLOAD_CONCURRENCY, upload.partCount) }, () => worker()));
    return parts;
}
async function uploadProxyParts(config, upload, file, signal, onProgress) {
    const parts = [];
    onProgress({ totalBytes: file.size, uploadedBytes: 0 });
    for (let partNumber = 1, offset = 0; offset < file.size; partNumber += 1) {
        const end = Math.min(file.size, offset + upload.chunkSizeBytes);
        const response = await withUploadRetries(() => controlRequest(config, partPath(upload.uploadId, partNumber), {
            body: file.slice(offset, end),
            headers: { "content-type": "application/octet-stream" },
            method: "PUT",
            signal,
        }), signal);
        parts.push(requireUploadedPart((await readJson(response)).part, partNumber, end - offset));
        offset = end;
        onProgress({ totalBytes: file.size, uploadedBytes: offset });
    }
    return parts;
}
function uploadPartToTarget(target, content, signal, onProgress) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const abort = () => request.abort();
        request.open(target.method, target.url, true);
        for (const [name, value] of Object.entries(target.headers ?? {}))
            request.setRequestHeader(name, value);
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
async function withUploadRetries(operation, signal) {
    let lastError;
    for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (!isRetryableUploadError(error) || attempt === MAX_UPLOAD_ATTEMPTS - 1)
                break;
            await abortableDelay(300 * 2 ** attempt, signal);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Asset upload failed after retries.");
}
async function controlRequest(config, path, init) {
    const headers = { ...(await resolveClientHeaders(config)), ...(init.headers ?? {}) };
    const base = config?.host || (typeof window !== "undefined" ? window.location.origin : "http://localhost");
    const response = await fetch(new URL(path, base).toString(), { ...init, credentials: "include", headers });
    if (!response.ok)
        throw new UploadHttpError(response.status, `Asset request failed (${response.status}).`);
    return response;
}
async function resolveClientHeaders(config) {
    const resolved = typeof config?.headers === "function" ? await config.headers() : config?.headers;
    if (config?.auth && "bearer" in config.auth) {
        const token = typeof config.auth.bearer === "function" ? await config.auth.bearer() : config.auth.bearer;
        return { ...(resolved ?? {}), authorization: `Bearer ${token}` };
    }
    return resolved ?? {};
}
async function readJson(response) {
    try {
        return await response.json();
    }
    catch {
        throw new Error("The asset service returned invalid JSON.");
    }
}
function requireUploadSession(value) {
    if (!value || typeof value !== "object")
        throw new Error("The asset service returned no upload session.");
    const upload = value;
    if (typeof upload.assetId !== "string" || typeof upload.uploadId !== "string"
        || !Number.isSafeInteger(upload.chunkSizeBytes) || Number(upload.chunkSizeBytes) <= 0
        || !Number.isSafeInteger(upload.partCount) || Number(upload.partCount) <= 0
        || typeof upload.filename !== "string"
        || typeof upload.mediaType !== "string"
        || !Number.isSafeInteger(upload.sizeBytes))
        throw new Error("The asset service returned an invalid upload session.");
    return upload;
}
function requireUploadTarget(value, partNumber) {
    if (!value || typeof value !== "object")
        throw new Error("The asset service returned no direct upload target.");
    const target = value;
    if (target.method !== "PUT" || target.partNumber !== partNumber || typeof target.url !== "string" || !/^https?:\/\//u.test(target.url)) {
        throw new Error("The asset service returned an invalid direct upload target.");
    }
    return target;
}
function requireUploadedPart(value, partNumber, sizeBytes) {
    if (!value || typeof value !== "object")
        throw new Error(`Asset part ${partNumber} was not acknowledged.`);
    const part = value;
    if (part.partNumber !== partNumber || part.sizeBytes !== sizeBytes)
        throw new Error(`Asset part ${partNumber} acknowledgement is invalid.`);
    return part;
}
function requireUploadedAsset(value) {
    if (!value || typeof value !== "object")
        throw new Error("The asset service returned no completed asset.");
    const asset = value;
    if (typeof asset.assetId !== "string" || typeof asset.filename !== "string"
        || typeof asset.mediaType !== "string" || !Number.isSafeInteger(asset.sizeBytes))
        throw new Error("The asset service returned invalid completed asset metadata.");
    return asset;
}
function partPath(uploadId, partNumber) {
    return `/api/assets/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`;
}
function isRetryableUploadError(error) {
    if (error instanceof RetryableUploadError)
        return true;
    if (error instanceof TypeError)
        return true;
    return error instanceof UploadHttpError && (error.status === 408 || error.status === 429 || error.status >= 500);
}
function abortableDelay(milliseconds, signal) {
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
    status;
    constructor(status, message) {
        super(message);
        this.name = "UploadHttpError";
        this.status = status;
    }
}
class RetryableUploadError extends Error {
    constructor(message) {
        super(message);
        this.name = "RetryableUploadError";
    }
}
function createProgressQueue() {
    const values = [];
    let closed = false;
    let wake;
    return {
        close() {
            closed = true;
            wake?.();
            wake = undefined;
        },
        async next() {
            while (values.length === 0 && !closed) {
                await new Promise((resolve) => { wake = resolve; });
                wake = undefined;
            }
            return values.shift();
        },
        push(value) {
            if (closed)
                return;
            values.splice(0, values.length, value);
            wake?.();
            wake = undefined;
        },
    };
}
//# sourceMappingURL=browser-asset-upload.js.map