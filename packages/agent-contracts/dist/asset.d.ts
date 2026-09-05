/**
 * Host-neutral asset contracts.
 *
 * Asset bytes deliberately do not appear in these request/metadata types. A
 * host may back the store with S3, R2, GCS, or the filesystem development
 * adapter, while Agent messages carry only the stable asset id and metadata.
 */
export type AssetOwner = {
    /** Optional authenticated actor type used by host adapters for isolation. */
    readonly issuer?: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly principalType?: string;
};
export type AssetStatus = "uploading" | "ready" | "failed" | "expired";
/** Content-safety state is independent from the byte-storage lifecycle. */
export type AssetScanStatus = "disabled" | "pending" | "scanning" | "clean" | "rejected" | "error";
export type AssetScanResult = {
    readonly status: "clean" | "rejected";
    /** Optional host-local diagnostic. It must not contain file bytes or secrets. */
    readonly reason?: string;
};
/**
 * Host-neutral content scanner. The Open Agent runtime never chooses a
 * vendor, endpoint, or credential; the host supplies this adapter when
 * untrusted uploads must be scanned before sandbox access.
 */
export interface AssetScanner {
    scan(input: {
        readonly asset: AssetMetadata;
        readonly openReadStream: () => Promise<ReadableStream<Uint8Array>>;
    }): Promise<AssetScanResult>;
}
export type AssetMetadata = {
    readonly assetId: string;
    readonly createdAt: string;
    readonly expiresAt?: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly messageId?: string;
    readonly principalId: string;
    readonly principalType?: string;
    readonly issuer?: string;
    readonly sessionId: string;
    readonly sizeBytes: number;
    readonly status: AssetStatus;
    readonly storageKey: string;
    readonly tenantId: string;
    readonly checksumSha256?: string;
    /** Optional for backwards-compatible host adapters; missing is fail-closed. */
    readonly scanStatus?: AssetScanStatus;
};
export type AssetUpload = {
    readonly chunkSizeBytes: number;
    readonly createdAt: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly maxBytes: number;
    readonly partCount?: number;
    /** Parts durably acknowledged by the application metadata store. */
    readonly parts?: readonly AssetPart[];
    readonly sizeBytes: number;
    readonly status: "uploading" | "ready" | "failed";
    /** Content scan state when the storage adapter exposes scanning. */
    readonly scanStatus?: AssetScanStatus;
    readonly uploadId: string;
    readonly assetId: string;
    readonly owner: AssetOwner;
    /**
     * `direct` means the browser sends bytes to a short-lived object-store URL.
     * `proxy` is reserved for development/custom adapters that accept bytes
     * through the application server.
     */
    readonly transferStrategy?: "direct" | "proxy";
};
export type AssetPart = {
    readonly etag?: string;
    readonly partNumber: number;
    readonly sizeBytes: number;
};
export type AssetPartUploadTarget = {
    readonly expiresAt: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: "PUT";
    readonly partNumber: number;
    readonly url: string;
};
export type AssetMessagePart = {
    readonly assetId: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly type: "asset";
};
export type AssetQuota = {
    readonly activeUploadBytes: number;
    readonly limitBytes: number;
    readonly usedBytes: number;
};
export type AssetCleanupResult = {
    /** Multipart uploads whose provider state was aborted and metadata removed. */
    readonly abortedUploads: number;
    /** Completed or failed asset objects whose metadata and bytes were removed. */
    readonly deletedAssets: number;
};
export type AssetReadOptions = {
    readonly end?: number;
    readonly start?: number;
};
export type AssetDownload = {
    readonly contentLength: number;
    readonly contentType: string;
    readonly filename: string;
    readonly stream: ReadableStream<Uint8Array>;
};
export interface AssetStore {
    createUpload(input: {
        readonly assetId?: string;
        readonly filename: string;
        readonly mediaType: string;
        readonly messageId?: string;
        readonly owner: AssetOwner;
        readonly sizeBytes: number;
        readonly sessionId: string;
        readonly expiresAt?: Date;
    }): Promise<AssetUpload>;
    writePart(input: {
        readonly content: Uint8Array;
        readonly owner: AssetOwner;
        readonly partNumber: number;
        readonly uploadId: string;
    }): Promise<AssetPart>;
    /**
     * Create a short-lived browser-to-object-store target. Production stores
     * should implement this so large bytes never traverse the application
     * server. Development adapters may omit it and use `writePart` instead.
     */
    createPartUpload?(input: {
        readonly owner: AssetOwner;
        readonly partNumber: number;
        readonly sizeBytes: number;
        readonly uploadId: string;
    }): Promise<AssetPartUploadTarget>;
    /** Persist the provider ETag returned after a direct part upload. */
    acknowledgePart?(input: {
        readonly etag: string;
        readonly owner: AssetOwner;
        readonly partNumber: number;
        readonly sizeBytes: number;
        readonly uploadId: string;
    }): Promise<AssetPart>;
    completeUpload(input: {
        readonly checksumSha256?: string;
        readonly owner: AssetOwner;
        /** Optional reconciliation payload for hosts that acknowledge at complete. */
        readonly parts?: readonly AssetPart[];
        readonly uploadId: string;
    }): Promise<AssetMetadata>;
    abortUpload(input: {
        readonly owner: AssetOwner;
        readonly uploadId: string;
    }): Promise<void>;
    deleteAsset(input: {
        readonly assetId: string;
        readonly owner: AssetOwner;
    }): Promise<void>;
    getQuota(owner: AssetOwner): Promise<AssetQuota>;
    /** Bind a pre-session browser upload to its first durable Agent session. */
    bindAssetSession?(input: {
        readonly assetId: string;
        readonly owner: AssetOwner;
        readonly sessionId: string;
    }): Promise<AssetMetadata | undefined>;
    findAsset(assetId: string, owner: AssetOwner): Promise<AssetMetadata | undefined>;
    findUpload(uploadId: string, owner: AssetOwner): Promise<AssetUpload | undefined>;
    /**
     * Recover an interrupted idempotent upload by its stable asset id. Hosts may
     * omit this when they do not support resumable app-authored imports.
     */
    findUploadByAsset?(assetId: string, owner: AssetOwner): Promise<AssetUpload | undefined>;
    /** Optional listing used by the session-assets side panel. */
    listAssets?(sessionId: string, owner: AssetOwner): Promise<readonly AssetMetadata[]>;
    /** Optional retention hook for a host-scheduled expiry worker. */
    cleanupExpired?(options?: {
        readonly limit?: number;
        readonly now?: Date;
    }): Promise<AssetCleanupResult>;
    openReadStream(assetId: string, owner: AssetOwner, options?: AssetReadOptions): Promise<AssetDownload | undefined>;
}
//# sourceMappingURL=asset.d.ts.map