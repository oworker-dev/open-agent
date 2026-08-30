import type { LanguageModelMiddleware } from "ai";

export class EveOwnedProviderAttemptError extends Error {
  readonly statusCode?: number;
  readonly isRetryable?: boolean;

  constructor(cause: unknown) {
    super(providerErrorMessage(cause));
    this.name = "EveOwnedProviderAttemptError";
    const statusCode = providerStatusCode(cause);
    if (statusCode !== undefined) this.statusCode = statusCode;
    const isRetryable = providerRetryable(cause, statusCode);
    if (isRetryable !== undefined) this.isRetryable = isRetryable;
  }
}

export class ProviderStreamInterruptedError extends Error {
  readonly isRetryable: boolean;
  readonly statusCode?: number;

  constructor(options: { readonly retryable?: boolean } = {}) {
    super("The model Provider stream ended before completion.");
    this.name = "ProviderStreamInterruptedError";
    this.isRetryable = options.retryable === true;
    // Eve treats an explicit true flag as transient, but does not use a false
    // flag to force terminal classification. A 4xx-class signal keeps a
    // post-tool interruption out of Workflow's durable step retry path, where
    // replaying the model step could duplicate an external side effect.
    if (!this.isRetryable) this.statusCode = 422;
  }
}

export const eveOwnedProviderRetryMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapGenerate: ({ doGenerate }) => oneProviderAttempt(doGenerate),
  wrapStream: async ({ doStream }) => {
    const result = await oneProviderAttempt(doStream);
    return { ...result, stream: preventReplayAfterStreamStarts(result.stream) };
  },
};

export async function oneProviderAttempt<T>(operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new EveOwnedProviderAttemptError(error);
  }
}

function providerErrorMessage(error: unknown): string {
  const statusCode = providerStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return `The model Provider rejected this request (HTTP ${statusCode}).`;
  }
  if (statusCode !== undefined) {
    return `The model Provider request failed (HTTP ${statusCode}).`;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The model Provider request timed out.";
  }
  return "The model Provider request failed.";
}

function providerStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const key of ["statusCode", "status"] as const) {
    const value = Reflect.get(error, key);
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }
  return undefined;
}

function providerRetryable(
  error: unknown,
  statusCode: number | undefined,
): boolean | undefined {
  // AI SDK marks every HTTP 404 as non-retryable before the provider response
  // body is inspected. A gateway can nevertheless use 404 for a temporary
  // route deployment, so only override that default when the response does
  // not identify a permanent missing/invalid model. The retry remains bounded
  // by Eve's model-call retry budget.
  if (error && typeof error === "object") {
    const explicit = Reflect.get(error, "isRetryable");
    if (typeof explicit === "boolean") {
      // AI SDK derives `false` from the bare HTTP status. For 404 only, keep
      // the session recoverable unless the provider body names a permanent
      // missing/invalid model. An explicit `true` remains authoritative.
      if (explicit === true) return true;
      if (statusCode !== 404 || isPermanentNotFound(error)) return false;
    }
  }
  if (isTransientNetworkError(error)) return true;
  if (statusCode === undefined) return undefined;
  // Gateways can temporarily return 404 while a model route is being
  // deployed or recovered. Treat an otherwise-unclassified 404 as
  // retryable; Eve owns a bounded three-attempt budget and parks an
  // interactive session after exhaustion instead of killing its context.
  return statusCode === 404 || statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

function isPermanentNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const values: string[] = [];
  for (const key of ["type", "code", "message", "responseBody"] as const) {
    const value = Reflect.get(error, key);
    if (typeof value === "string") values.push(value);
  }
  const data = Reflect.get(error, "data");
  if (data !== undefined) {
    try {
      values.push(JSON.stringify(data));
    } catch {
      // Ignore unserializable provider metadata.
    }
  }
  return /(?:model[_ -]?not[_ -]?found|unknown[_ -]?model|resource[_ -]?not[_ -]?found|invalid[_ -]?request(?:[_ -]?error)?|model[^\n]{0,40}does not exist)/iu.test(values.join("\n"));
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error instanceof TypeError)) {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function preventReplayAfterStreamStarts<T>(stream: ReadableStream<T>): ReadableStream<T> {
  const reader = stream.getReader();
  let receivedProviderOutput = false;
  let crossedToolBoundary = false;
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        const part = result.value;
        if (receivedProviderOutput && isStreamErrorPart(part)) {
          controller.enqueue({
            ...part,
            error: new ProviderStreamInterruptedError({ retryable: !crossedToolBoundary }),
          });
          return;
        }
        if (!isStreamErrorPart(part)) {
          receivedProviderOutput = true;
          if (crossesToolBoundary(part)) crossedToolBoundary = true;
        }
        controller.enqueue(part);
      } catch (error) {
        if (isAbortError(error) || !receivedProviderOutput) {
          controller.error(error);
          return;
        }
        controller.error(
          new ProviderStreamInterruptedError({ retryable: !crossedToolBoundary }),
        );
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function isStreamErrorPart(value: unknown): value is { readonly type: "error"; readonly error: unknown } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "error";
}

function crossesToolBoundary(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("type" in value)) return true;
  const type = Reflect.get(value, "type");
  return typeof type !== "string" || type.startsWith("tool-") || type === "raw";
}
