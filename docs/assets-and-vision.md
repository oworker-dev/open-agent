# Assets, Uploads, And Vision

This document defines the host-neutral contract for user files, generated
media, sandbox access, and visual understanding. It is deliberately separate
from the conversation UI and from the Muses domain model. The same contract
must work for the standalone Open Agent product, Muses, and another host that
provides an object store and a sandbox adapter.

## Why the current attachment path is not production-ready

The current browser attachment adapter has three incompatible properties for a
web Agent product:

- it rejects files above 20 MiB;
- it reads the entire file into a browser data URL;
- it sends the bytes inside the Eve message and durable history.

The current `ArtifactStore` is a result-delivery store, not an upload store. It
keeps bytes in PostgreSQL `bytea` or a local filesystem and caps one artifact at
25 MiB. Raising that constant would make memory pressure, request limits,
database bloat, and event replay worse. It is not a solution for 100 MiB+ user
uploads.

The current message projection also rewrites image parts to the generic
`image/*` MIME type. The asset contract must preserve the authoritative media
type (`image/png`, `image/jpeg`, `image/webp`, and so on) so model adapters and
browser previews can apply the correct decoder and safety policy.

The production rule is therefore: **conversation events contain asset
references and metadata, never large file bytes**. The original bytes belong in
an object store and are mounted into a session sandbox only when the Agent or a
host operation needs them.

## Asset model

An `Asset` is an authenticated, immutable object with a mutable lifecycle. The
minimum record is:

```ts
type AssetRecord = {
  assetId: string;
  tenantId: string;
  principalId: string;
  sessionId?: string;
  threadId?: string;
  messageId?: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
  storageKey: string;
  status: "pending" | "uploading" | "available" | "scanning" | "rejected" | "expired";
  visibility: "session" | "thread" | "private" | "published";
  createdAt: string;
  expiresAt?: string;
};
```

`assetId` is the only identifier that may be placed in a user message. The
storage key is never user-controlled and is never exposed as an authorization
token. Filename, content type, size, ownership, retention, and quota are
validated by the server; the browser is not an authority for any of them.

The first production conformance target is **at least 100 MiB per asset**. The
limit is host-configurable and must be enforced by tenant and principal quota,
not by a hard-coded UI constant. Hosts may choose a larger limit for video or
archive workflows without changing the Agent message protocol.

## Upload protocol

The default implementation is an S3-compatible object-store adapter. Muses can
replace it with its own OSS/S3/R2 adapter through the same interface.

```ts
interface AssetStore {
  createUpload(input: CreateUploadInput): Promise<UploadSession>;
  completeUpload(input: CompleteUploadInput): Promise<AssetRecord>;
  abortUpload(uploadId: string): Promise<void>;
  getAsset(assetId: string, owner: AssetOwner): Promise<AssetRecord>;
  createDownloadUrl(assetId: string, purpose: DownloadPurpose): Promise<string>;
  openReadStream(assetId: string, owner: AssetOwner, range?: ByteRange): Promise<ReadableStream>;
  mountToSandbox(assetId: string, sandbox: SandboxRef): Promise<MountedAsset>;
  deleteAsset(assetId: string, owner: AssetOwner): Promise<void>;
  getQuota(owner: AssetOwner): Promise<AssetQuota>;
}
```

The browser flow is:

1. Request an upload session with filename, media type, byte size, and an
   idempotency key.
2. Upload parts directly to the object store with short-lived signed URLs.
   Parts are resumable and retried independently; the application server does
   not proxy the file bytes.
3. Complete the upload with the part checksums. The server verifies the final
   size and checksum, records the `Asset`, and starts optional malware/content
   scanning.
4. Submit a message containing `assetId`, display metadata, and the user's
   text. The message is small and durable even when the file is 100 MiB or
   larger.

Uploads must support HTTP range reads, abort, retry, reconnect, and expiration.
The UI must not wait for a full browser read before displaying progress or
allowing a second attachment. A failed part can be retried without re-uploading
the complete file. A completed upload that is not referenced by a message is
reclaimed by a TTL job.

The local filesystem adapter is for development and deterministic tests only.
The production doctor must reject a database-byte or data-URL upload path and
must require an object-store adapter with a configured quota and retention
policy.

### Current implementation status

The repository now includes a host-neutral `AssetStore` contract in
`@oworker/open-agent-contracts/asset`, a filesystem development adapter in
`server/data/asset-store.ts`, and resumable HTTP endpoints under
`/api/assets/uploads`. The adapters accept declarations up to 10 GiB, write
bounded parts (8 MiB by default, 16 MiB maximum), verify the completed SHA-256
checksum, support owner-scoped range reads, and stream completed objects to a
sandbox. Neither adapter puts content in Eve messages or PostgreSQL bytea.

The built-in production adapter combines PostgreSQL metadata with an
S3-compatible multipart object store (`AGENT_ASSET_STORAGE_BACKEND=s3`). It
supports MinIO, S3, R2, and compatible gateways through the same endpoint,
bucket, credentials, and path-style settings. A host can still register a
custom `AssetStore` with `configureAssetStore()` when it owns a different
storage system. Setting `AGENT_ASSET_STORAGE_BACKEND` to an unsupported value
fails closed rather than silently falling back to local disk. The migrations
`server/data/migrations/0002_asset_metadata.sql` and
`0005_asset_scan_status.sql` contain metadata, upload, part-pointer, and scan
state only; they intentionally have no bytea content columns.

`AGENT_ASSET_MAX_BYTES` limits one object. `AGENT_ASSET_QUOTA_BYTES` is the
aggregate per-tenant/principal reservation limit and is required for production
S3 deployments. The S3 adapter checks `ready + uploading + requested` bytes
under a PostgreSQL advisory transaction lock before creating the metadata
reservation, so concurrent multipart admissions cannot oversubscribe a quota.
The filesystem adapter applies the same accounting for local development; a
custom host adapter owns its own atomic quota implementation.

Checksum verification is not malware scanning. `AssetMetadata.scanStatus` and
the host-neutral `AssetScanner` contract make this boundary explicit. A
production host registers its scanner with `configureAssetScanner()` before
using the built-in S3 adapter; the adapter fails closed when scanning is
required but no scanner is present. Development/test deployments may explicitly
set `AGENT_ASSET_SCAN_MODE=disabled`. `import_asset` and sandbox mounts admit
only `clean` or explicitly `disabled` assets. The built-in S3 adapter is not,
by itself, a malware-scanning solution.

The built-in `import_asset` tool materializes an authenticated asset into the
current workspace through Eve's streaming sandbox primitive. A first-turn
browser upload is provisionally tagged with a `browser-*` session id; the first
successful import atomically binds it to the current durable session. Assets
already bound to another session are rejected, even for the same principal.
`view_image`
validates sandbox paths and common image signatures and emits a typed Eve file
part capped at 3 MiB. When the sandbox provides ImageMagick, oversized images
are downscaled to a bounded JPEG preview before being sent to the model;
otherwise the tool returns a recoverable instruction to resize the image. The
S3 adapter is storage-production-capable once its object-store lifecycle,
quota, retention, and credentials are configured; a real local MinIO gate has
validated a 100 MiB upload, interrupted-part retry, Range reads, and owner
isolation. It still needs a host scanner before it can be promoted for
untrusted uploads. Both built-in adapters expose
an optional bounded `cleanupExpired()` hook; production deployments should run
`npm run reap:assets` from a scheduler so expired objects and abandoned
multipart uploads are removed even when no user requests arrive. The
filesystem adapter remains development-only.

## Message and model boundary

The user message carries a host-neutral reference, not a data URL:

```ts
type AssetMessagePart = {
  type: "asset";
  assetId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
};
```

The Agent does not pre-parse every upload. It may use a typed tool or a host
capability to extract text, OCR, metadata, or a thumbnail when the task asks
for it. This keeps large or opaque files usable without imposing a costly parse
on every request.

At the beginning of a turn, the runtime authorizes referenced assets against
the current tenant, principal, session, and message. On demand, the sandbox
adapter mounts them read-only at a stable path:

```text
/workspace/.open-agent/assets/<asset-id>/<safe-filename>
```

The Agent receives the path and metadata, never object-store credentials. The
mount is session-scoped, idempotent, and removed with the sandbox or explicit
asset deletion. A host may implement the mount with a streaming filesystem,
ephemeral download, or a copy-on-first-read, but it must preserve the same
ownership and path contract.

## `view_image` tool

Open Agent needs a host-neutral image inspection tool modeled on Codex's
`view_image`. It is a built-in capability of the sandbox Agent, not a Muses
tool and not a UI-only shortcut.

```ts
type ViewImageInput = {
  path: string;
  maxWidth?: number;
  maxHeight?: number;
  detail?: "auto" | "low" | "high";
};
```

The tool must:

- accept only a sandbox path under `/workspace` (or an authorized `assetId`
  resolved by the runtime);
- verify the path exists, is a regular image, and is inside the current
  session sandbox;
- preserve the original image in the sandbox/object store;
- resize or encode a model-facing copy with a bounded byte size (target less
  than 3 MiB per image, configurable by model capability);
- return a typed file/image part through the Eve tool output so a vision-capable
  model can actually see the pixels;
- return dimensions, media type, and a stable asset reference for the UI;
- fail with a useful typed error for missing files, unsupported formats, or a
  non-vision model.

The model adapter must declare `vision` capability. If the selected model is
text-only, the runtime must report that limitation instead of silently sending
an unusable image part. Multiple images are bounded by turn and tenant quota.

### Remote binary import

`web_fetch` is intentionally a bounded metadata/text tool and currently drops
binary response bodies. It must not be changed to put arbitrary binary bytes in
an Eve observation. Add a separate `import_asset` operation for an explicitly
requested remote resource:

```ts
type ImportAssetInput = {
  url: string;
  filename?: string;
  mediaTypeHint?: string;
};
```

The operation applies host SSRF policy, DNS/IP restrictions, response-size and
redirect limits, content-type sniffing, checksum calculation, and tenant quota.
It streams the response into `AssetStore`, returns an `assetId`, and makes the
asset available for a later sandbox mount or `view_image` call. It does not
return the binary body in the model observation. A host may disable remote
import completely.

Generated images, screenshots, and files created by tools use the same Asset
contract. A tool may publish an asset explicitly; automatic persistence is
reserved for declared output types so an arbitrary `/workspace` tree is not
silently copied to durable storage.

## UI contract

The reference Web client uses assistant-ui's Attachment primitives in all three
surfaces:

1. **Composer**: compact rounded preview cards (`size="sm"` or `"xs"`) in a
   horizontal `AttachmentGroup`, with thumbnail, filename, size, upload
   progress, retry, and remove actions. The card must not stretch across the
   composer as a filename bar.
2. **User message**: completed attachment cards at the message's top, larger
   than composer cards. Image cards open a modal/lightbox preview without
   navigating away from the thread.
3. **Tool output**: `view_image` and other media results render the same native
   rounded card with the tool's status and asset link. Raw JSON is a fallback
   only for unknown tools.

The attachment adapter is responsible for upload state, not for encoding file
bytes into `CompleteAttachment.content`. It should return an asset reference
and a short-lived preview/download URL. The assistant-ui card remains usable
after a refresh by resolving that reference through the authenticated host
adapter.

Upload progress, retry, cancel, and quota errors are visible inline. A large
upload must not block stream reconnect, message history hydration, or the
Composer. Mobile layout uses a horizontal scroll group and an image preview
sheet rather than a full-width card that changes the input height unpredictably.

## Security, retention, and capacity

- Every read, mount, download URL, and delete checks tenant and principal
  ownership. A signed URL is scoped to one asset and one purpose with a short
  expiry.
- Object keys are generated server-side. User filenames are display metadata
  only and are sanitized before mounting.
- The store records checksum, size, media type, upload status, ownership, and
  durable `scanStatus`. Scanner implementation remains a host responsibility;
  production imports fail closed unless the status is `clean` (or scanning was
  explicitly disabled outside production).
- Per-tenant byte quota, per-principal quota, concurrent upload quota, and
  active mounted-byte quota are admission controls. They are separate from
  model-token and sandbox CPU quotas.
- Range reads and streaming mounts prevent a 100 MiB file from becoming a
  single Node buffer. Database rows contain metadata and pointers, never the
  primary object bytes.
- Expiry and deletion are idempotent. A deleted asset invalidates all new URLs;
  existing downloads are allowed to finish only according to the host's
  retention policy.
- Optional malware scanning is asynchronous for low-risk previews and blocking
  for sandbox execution, executable archives, or host-defined sensitive types.

## Implementation phases and gates

### P0: contract and storage foundation

- Add `AssetStore`, `AssetMessagePart`, upload-session, quota, and mount types to
  the public contracts package.
- Add an object-store adapter with multipart/resumable upload, range reads,
  checksums, idempotency, and owner-scoped signed URLs.
- Add metadata migration and an adapter that keeps the existing artifact store
  as a compatibility projection only. Do not increase the 25 MiB artifact
  constant.
- Add session-scoped mount preparation and cleanup hooks to the sandbox
  lifecycle.
- Replace the browser data-URL adapter with an asset-reference adapter.
- Add `import_asset` as the bounded binary counterpart to `web_fetch`.

**Gate:** a 100 MiB fixture uploads with bounded server memory, survives a
client reconnect, appears in the user message after refresh, mounts read-only
in the correct sandbox, and is inaccessible from another tenant.

### P1: visual understanding and native attachment UI

- Implement `view_image` with bounded conversion and vision capability checks.
- Feed user image assets and tool image outputs through typed multimodal parts.
- Use assistant-ui Attachment cards in Composer, user messages, and tool output;
  add click-to-preview, progress, retry, and remove behavior.
- Add deterministic tests for image upload, model-facing image output, sandbox
  image inspection, unsupported formats, and text-only models.

**Gate:** the Agent can receive a user image, call `view_image` on a sandbox
  image, and describe the correct pixels; the UI shows the same attachment
  style in the composer, transcript, and tool result without raw JSON.

### P2: host integration and capacity

- Publish Muses' object-store and model-capability adapters without importing
  Muses types into the Open Agent kernel.
- Add a durable scan-status field and host scanner adapter, scan/retention
  workers, quota dashboards, signed URL revocation, and orphan-upload cleanup.
- Load-test idle connections, concurrent 100 MiB uploads, mount storms, image
  conversion, reconnects, and provider failures together.

**Release gate:** physical sandbox isolation, object-store failure recovery,
  host-provided malware/content scanning with fail-closed import, quota
  enforcement, deletion/expiry audits, and a capacity report with CPU, memory,
  database connections, object-store throughput, and active sandbox limits.
  Until these gates pass, the product remains an alpha release even if the UI
  works for small files.

## Non-goals

- Do not put an object-store SDK or Muses billing code in the Agent UI package.
- Do not parse every upload before the Agent can use it.
- Do not expose arbitrary sandbox ports or object-store credentials to the
  browser.
- Do not treat `ArtifactStore` or a signed preview link as a general asset
  registry.
- Do not add a second ad-hoc image viewer for one tool; all media previews use
  the shared assistant-ui Attachment contract.
