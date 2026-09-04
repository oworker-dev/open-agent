import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { finished } from "node:stream/promises";

export type WorkflowArchiveObject = {
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

export interface WorkflowArchiveObjectStore {
  close(): void;
  downloadVerified(input: {
    readonly key: string;
    readonly path: string;
    readonly sha256: string;
    readonly signal?: AbortSignal;
    readonly sizeBytes: number;
  }): Promise<void>;
  putVerified(input: {
    readonly key: string;
    readonly manifestSha256: string;
    readonly path: string;
    readonly sha256: string;
    readonly signal?: AbortSignal;
    readonly sizeBytes: number;
  }): Promise<WorkflowArchiveObject>;
}

export type WorkflowArchiveObjectStoreConfig = {
  readonly accessKeyId: string;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly prefix: string;
  readonly region: string;
  readonly secretAccessKey: string;
};

export function createWorkflowArchiveObjectStore(
  config: WorkflowArchiveObjectStoreConfig,
): WorkflowArchiveObjectStore {
  const client = new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return createWorkflowArchiveObjectStoreWithClient(config.bucket, client);
}

export function createWorkflowArchiveObjectStoreWithClient(
  bucket: string,
  client: Pick<S3Client, "destroy" | "send">,
): WorkflowArchiveObjectStore {
  return {
    close() {
      client.destroy();
    },
    async downloadVerified(input) {
      assertKey(input.key);
      assertSha256(input.sha256, "sha256");
      assertSize(input.sizeBytes);
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: input.key }),
        { abortSignal: input.signal },
      );
      if (Number(response.ContentLength) !== input.sizeBytes) {
        throw new Error("Workflow archive object size does not match its archive record.");
      }
      const body = response.Body as AsyncIterable<Uint8Array> | undefined;
      if (!body) throw new Error("Workflow archive object store returned no download body.");
      const writer = createWriteStream(input.path, { flags: "wx", mode: 0o600 });
      const hash = createHash("sha256");
      let sizeBytes = 0;
      try {
        for await (const chunk of body) {
          if (input.signal?.aborted) throw input.signal.reason ?? new Error("Workflow archive download was cancelled.");
          sizeBytes += chunk.byteLength;
          if (sizeBytes > input.sizeBytes) throw new Error("Workflow archive object exceeded its recorded size.");
          hash.update(chunk);
          if (!writer.write(chunk)) await waitForDrain(writer);
        }
        writer.end();
        await finished(writer);
        if (sizeBytes !== input.sizeBytes) throw new Error("Workflow archive object download was incomplete.");
        if (hash.digest("hex") !== input.sha256) {
          throw new Error("Workflow archive object checksum does not match its archive record.");
        }
      } catch (error) {
        writer.destroy();
        await unlink(input.path).catch(() => undefined);
        throw error;
      }
    },
    async putVerified(input) {
      assertKey(input.key);
      assertSha256(input.sha256, "sha256");
      assertSha256(input.manifestSha256, "manifestSha256");
      assertSize(input.sizeBytes);
      if (!(await matchesExpectedObject(client, bucket, input))) {
        await client.send(new PutObjectCommand({
          Body: createReadStream(input.path),
          Bucket: bucket,
          ContentLength: input.sizeBytes,
          ContentType: "application/x-ndjson",
          Key: input.key,
          Metadata: {
            "archive-format": "open-agent.workflow-archive.v2",
            "manifest-sha256": input.manifestSha256,
            "object-sha256": input.sha256,
          },
        }), { abortSignal: input.signal });
      }
      const remoteSha256 = await hashRemoteObject(client, bucket, input.key, input.sizeBytes, input.signal);
      if (remoteSha256 !== input.sha256) {
        throw new Error("Workflow archive object checksum verification failed after upload.");
      }
      return { key: input.key, sha256: input.sha256, sizeBytes: input.sizeBytes };
    },
  };
}

export function readWorkflowArchiveObjectStoreConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowArchiveObjectStoreConfig {
  const value = (archiveName: string, assetName: string): string | undefined =>
    environment[archiveName]?.trim() || environment[assetName]?.trim();
  const accessKeyId = required(value("WORKFLOW_ARCHIVE_S3_ACCESS_KEY_ID", "AGENT_ASSET_S3_ACCESS_KEY_ID"), "WORKFLOW_ARCHIVE_S3_ACCESS_KEY_ID");
  const bucket = required(value("WORKFLOW_ARCHIVE_S3_BUCKET", "AGENT_ASSET_S3_BUCKET"), "WORKFLOW_ARCHIVE_S3_BUCKET");
  const secretAccessKey = required(value("WORKFLOW_ARCHIVE_S3_SECRET_ACCESS_KEY", "AGENT_ASSET_S3_SECRET_ACCESS_KEY"), "WORKFLOW_ARCHIVE_S3_SECRET_ACCESS_KEY");
  const endpoint = value("WORKFLOW_ARCHIVE_S3_ENDPOINT", "AGENT_ASSET_S3_ENDPOINT");
  const forcePathStyle = parseBoolean(
    value("WORKFLOW_ARCHIVE_S3_FORCE_PATH_STYLE", "AGENT_ASSET_S3_FORCE_PATH_STYLE"),
    true,
  );
  const prefix = normalizePrefix(environment.WORKFLOW_ARCHIVE_S3_PREFIX?.trim() || "workflow-archives/v2");
  const region = value("WORKFLOW_ARCHIVE_S3_REGION", "AGENT_ASSET_S3_REGION") || "us-east-1";
  return { accessKeyId, bucket, endpoint, forcePathStyle, prefix, region, secretAccessKey };
}

export function workflowArchiveObjectKey(prefix: string, rootRunId: string): string {
  if (!rootRunId.trim() || rootRunId.length > 512) throw new Error("rootRunId is invalid.");
  const digest = createHash("sha256").update(rootRunId).digest("hex");
  return `${normalizePrefix(prefix)}/${digest.slice(0, 2)}/${digest}.ndjson`;
}

async function matchesExpectedObject(
  client: Pick<S3Client, "send">,
  bucket: string,
  input: {
    readonly key: string;
    readonly manifestSha256: string;
    readonly sha256: string;
    readonly signal?: AbortSignal;
    readonly sizeBytes: number;
  },
): Promise<boolean> {
  try {
    const response = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: input.key }),
      { abortSignal: input.signal },
    );
    return Number(response.ContentLength) === input.sizeBytes
      && response.Metadata?.["archive-format"] === "open-agent.workflow-archive.v2"
      && response.Metadata?.["manifest-sha256"] === input.manifestSha256
      && response.Metadata?.["object-sha256"] === input.sha256;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === "NotFound") return false;
    throw error;
  }
}

async function hashRemoteObject(
  client: Pick<S3Client, "send">,
  bucket: string,
  key: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<string> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
  if (Number(response.ContentLength) !== expectedSize) {
    throw new Error("Workflow archive object size verification failed after upload.");
  }
  const body = response.Body as AsyncIterable<Uint8Array> | undefined;
  if (!body) throw new Error("Workflow archive object store returned no verification body.");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of body) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > expectedSize) throw new Error("Workflow archive object exceeded its expected size.");
    hash.update(chunk);
  }
  if (sizeBytes !== expectedSize) throw new Error("Workflow archive object body was incomplete.");
  return hash.digest("hex");
}

function normalizePrefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/gu, "");
  if (!prefix || prefix.length > 1_000 || prefix.includes("..")) {
    throw new Error("WORKFLOW_ARCHIVE_S3_PREFIX must be a bounded object-key prefix.");
  }
  return prefix;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("WORKFLOW_ARCHIVE_S3_FORCE_PATH_STYLE must be true or false.");
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required (the matching AGENT_ASSET_S3 value may be used as a fallback).`);
  return value;
}

function assertKey(value: string): void {
  if (!value || value.length > 2_000 || value.startsWith("/")) throw new Error("Workflow archive object key is invalid.");
}

function assertSha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest.`);
}

function assertSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Workflow archive size must be positive.");
}

async function waitForDrain(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}
