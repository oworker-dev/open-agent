import { summarizeLatencies } from "./load-slo.ts";

export const ASSET_LOAD_DEFAULT_SIZE_BYTES = 100 * 1024 * 1024;
export const ASSET_LOAD_MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
export const ASSET_LOAD_MAX_PART_BYTES = 16 * 1024 * 1024;

export type AssetLoadConfig = {
  readonly baseUrl: string;
  readonly concurrency: number;
  readonly totalUploads: number;
  readonly sizeBytes: number;
  readonly deadlineMs: number;
  readonly maxErrorRate: number;
  readonly minThroughputMiBPerSecond: number;
  readonly p95UploadMs: number;
};

export type AssetLoadResult = {
  readonly ok: boolean;
  readonly assetId?: string;
  readonly durationMs?: number;
  readonly error?: string;
  readonly bytes?: number;
  readonly retries?: number;
  readonly interruptedParts?: number;
};

export type AssetLoadMetrics = {
  readonly upload: ReturnType<typeof summarizeLatencies>;
  readonly errorRate: number;
  readonly throughputMiBPerSecond: number;
  readonly successes: number;
  readonly failures: number;
  readonly bytesUploaded: number;
  readonly retries: number;
  readonly interruptedParts: number;
};

export function parseAssetLoadConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AssetLoadConfig {
  const baseUrl = (environment.AGENT_ASSET_LOAD_BASE_URL?.trim() || "http://127.0.0.1:3100").replace(/\/$/u, "");
  const parsedBaseUrl = new URL(baseUrl);
  if (!(["http:", "https:"] as string[]).includes(parsedBaseUrl.protocol)) {
    throw new Error("AGENT_ASSET_LOAD_BASE_URL must use http or https.");
  }
  return {
    baseUrl,
    concurrency: boundedInteger(environment, "AGENT_ASSET_LOAD_CONCURRENCY", 2, 1, 8),
    totalUploads: boundedInteger(
      environment,
      "AGENT_ASSET_LOAD_TOTAL_UPLOADS",
      boundedInteger(environment, "AGENT_ASSET_LOAD_CONCURRENCY", 2, 1, 8),
      1,
      32,
    ),
    sizeBytes: boundedBytes(environment, "AGENT_ASSET_LOAD_SIZE_BYTES", ASSET_LOAD_DEFAULT_SIZE_BYTES, 1 * 1024 * 1024, ASSET_LOAD_MAX_SIZE_BYTES),
    deadlineMs: boundedInteger(environment, "AGENT_ASSET_LOAD_DEADLINE_MS", 600_000, 1_000, 900_000),
    maxErrorRate: boundedNumber(environment, "AGENT_ASSET_LOAD_MAX_ERROR_RATE", 0, 0, 1),
    minThroughputMiBPerSecond: boundedNumber(environment, "AGENT_ASSET_LOAD_MIN_THROUGHPUT_MIBPS", 1, 0, 100_000),
    p95UploadMs: boundedInteger(environment, "AGENT_ASSET_LOAD_P95_UPLOAD_MS", 600_000, 100, 900_000),
  };
}

export function evaluateAssetLoad(
  results: readonly AssetLoadResult[],
  measuredDurationMs: number,
  config: Pick<AssetLoadConfig, "maxErrorRate" | "minThroughputMiBPerSecond" | "p95UploadMs">,
): { readonly metrics: AssetLoadMetrics; readonly violations: readonly string[] } {
  const successes = results.filter((result) => result.ok);
  const failures = results.length - successes.length;
  const bytesUploaded = successes.reduce((total, result) => total + (result.bytes ?? 0), 0);
  const metrics: AssetLoadMetrics = {
    upload: summarizeLatencies(successes.flatMap((result) => result.durationMs === undefined ? [] : [result.durationMs])),
    errorRate: results.length === 0 ? 1 : failures / results.length,
    throughputMiBPerSecond: round(bytesUploaded / 1024 / 1024 / Math.max(measuredDurationMs / 1_000, 0.001), 2),
    successes: successes.length,
    failures,
    bytesUploaded,
    retries: results.reduce((total, result) => total + (result.retries ?? 0), 0),
    interruptedParts: results.reduce((total, result) => total + (result.interruptedParts ?? 0), 0),
  };
  const violations: string[] = [];
  if (metrics.upload.p95Ms !== null && metrics.upload.p95Ms > config.p95UploadMs) {
    violations.push(`Upload p95 ${metrics.upload.p95Ms}ms exceeded ${config.p95UploadMs}ms.`);
  }
  if (metrics.errorRate > config.maxErrorRate) {
    violations.push(`Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeded ${(config.maxErrorRate * 100).toFixed(2)}%.`);
  }
  if (metrics.throughputMiBPerSecond < config.minThroughputMiBPerSecond) {
    violations.push(`Throughput ${metrics.throughputMiBPerSecond.toFixed(2)} MiB/s was below ${config.minThroughputMiBPerSecond.toFixed(2)} MiB/s.`);
  }
  return { metrics, violations };
}

export function deterministicPart(uploadIndex: number, partNumber: number, sizeBytes: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  const seed = (uploadIndex * 31 + partNumber * 17) & 0xff;
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (seed + index) & 0xff;
  return bytes;
}

function boundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boundedBytes(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)?$/iu.exec(raw);
  const multiplier = match?.[2]?.toLowerCase() === "kib" ? 1024
    : match?.[2]?.toLowerCase() === "mib" ? 1024 * 1024
      : match?.[2]?.toLowerCase() === "gib" ? 1024 * 1024 * 1024 : 1;
  const value = match ? Number(match[1]) * multiplier : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a byte size from ${minimum} to ${maximum} (B, KiB, MiB, or GiB).`);
  }
  return value;
}

function boundedNumber(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
