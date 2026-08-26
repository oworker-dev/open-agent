export type ProductionDiagnostic = {
  readonly code: string;
  readonly level: "error" | "warning";
  readonly message: string;
};

export type AgentSandboxBackendName = "auto" | "docker" | "microsandbox" | "vercel";
export type AgentDeploymentTenancy = "single-tenant" | "multi-tenant";

/**
 * Logical per-session reservation limit for assets materialized into
 * `/workspace` by the import_asset tool. The sandbox backend should still
 * apply a physical disk limit; this guard protects the durable import path
 * before a host-specific disk quota is available.
 */
export const DEFAULT_AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES = 10 * 1024 ** 3;
export const MAX_AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES = 10 * 1024 ** 4;

/**
 * Docker's Eve backend does not expose resource flags.  Keep a conservative
 * default for local development and require explicit values in production;
 * the Docker sandbox adapter applies these values after each container is
 * created or reattached.
 */
export const DEFAULT_AGENT_DOCKER_MEMORY_LIMIT_BYTES = 2 * 1024 ** 3;
export const MAX_AGENT_DOCKER_MEMORY_LIMIT_BYTES = 64 * 1024 ** 3;
export const DEFAULT_AGENT_DOCKER_CPU_LIMIT = 2;
export const MAX_AGENT_DOCKER_CPU_LIMIT = 64;
export const DEFAULT_AGENT_DOCKER_PIDS_LIMIT = 512;
export const MAX_AGENT_DOCKER_PIDS_LIMIT = 32_768;

export type AgentDockerResourceLimits = {
  readonly memoryBytes: number;
  readonly cpus: number;
  readonly pidsLimit: number;
};

export function readAgentDockerResourceLimits(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentDockerResourceLimits {
  const requiredKeys = [
    "AGENT_DOCKER_MEMORY_LIMIT_BYTES",
    "AGENT_DOCKER_CPU_LIMIT",
    "AGENT_DOCKER_PIDS_LIMIT",
  ] as const;
  const missing = requiredKeys.filter((key) => !environment[key]?.trim());
  if (environment.NODE_ENV === "production" && missing.length > 0) {
    throw new Error(`${missing.join(", ")} must be explicitly configured in production.`);
  }
  const memoryBytes = readBoundedBytes(
    environment.AGENT_DOCKER_MEMORY_LIMIT_BYTES,
    DEFAULT_AGENT_DOCKER_MEMORY_LIMIT_BYTES,
    MAX_AGENT_DOCKER_MEMORY_LIMIT_BYTES,
    "AGENT_DOCKER_MEMORY_LIMIT_BYTES",
  );
  const cpusRaw = environment.AGENT_DOCKER_CPU_LIMIT?.trim();
  const cpus = cpusRaw ? Number(cpusRaw) : DEFAULT_AGENT_DOCKER_CPU_LIMIT;
  if (!Number.isFinite(cpus) || cpus < 0.1 || cpus > MAX_AGENT_DOCKER_CPU_LIMIT) {
    throw new Error(
      `AGENT_DOCKER_CPU_LIMIT must be a number between 0.1 and ${MAX_AGENT_DOCKER_CPU_LIMIT}.`,
    );
  }
  const pidsRaw = environment.AGENT_DOCKER_PIDS_LIMIT?.trim();
  const pidsLimit = pidsRaw ? Number(pidsRaw) : DEFAULT_AGENT_DOCKER_PIDS_LIMIT;
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 64 || pidsLimit > MAX_AGENT_DOCKER_PIDS_LIMIT) {
    throw new Error(
      `AGENT_DOCKER_PIDS_LIMIT must be an integer between 64 and ${MAX_AGENT_DOCKER_PIDS_LIMIT}.`,
    );
  }
  return { memoryBytes, cpus, pidsLimit };
}

function readBoundedBytes(
  raw: string | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const match = /^(\d+)(?:\s*(KiB|MiB|GiB|TiB))?$/iu.exec(value);
  if (!match) {
    throw new Error(`${name} must be an integer with an optional KiB, MiB, GiB, or TiB suffix.`);
  }
  const multiplier = match[2]?.toLowerCase() === "kib"
    ? 1024
    : match[2]?.toLowerCase() === "mib"
      ? 1024 ** 2
      : match[2]?.toLowerCase() === "gib"
        ? 1024 ** 3
        : match[2]?.toLowerCase() === "tib"
          ? 1024 ** 4
          : 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < 64 * 1024 ** 2 || bytes > maximum) {
    throw new Error(`${name} must be between 64MiB and ${maximum} bytes.`);
  }
  return bytes;
}

export function readAgentSandboxWorkspaceQuota(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = environment.AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES?.trim();
  if (!value) return DEFAULT_AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES;
  const match = /^(\d+)(?:\s*(KiB|MiB|GiB|TiB))?$/iu.exec(value);
  if (!match) {
    throw new Error(
      "AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES must be a positive byte count with an optional KiB, MiB, GiB, or TiB suffix.",
    );
  }
  const multiplier = match[2]?.toLowerCase() === "kib"
    ? 1024
    : match[2]?.toLowerCase() === "mib"
      ? 1024 ** 2
      : match[2]?.toLowerCase() === "gib"
        ? 1024 ** 3
        : match[2]?.toLowerCase() === "tib"
          ? 1024 ** 4
          : 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES) {
    throw new Error(
      `AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES must be between 1 byte and ${MAX_AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES} bytes.`,
    );
  }
  return bytes;
}

const SANDBOX_BACKENDS = new Set<AgentSandboxBackendName>([
  "auto",
  "docker",
  "microsandbox",
  "vercel",
]);
const DEPLOYMENT_TENANCIES = new Set<AgentDeploymentTenancy>([
  "single-tenant",
  "multi-tenant",
]);
const EXTENSION_REF = /^[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;

export function readAgentSandboxBackend(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentSandboxBackendName {
  const configured = environment.AGENT_SANDBOX_BACKEND?.trim() || "auto";
  if (!SANDBOX_BACKENDS.has(configured as AgentSandboxBackendName)) {
    throw new Error(
      "AGENT_SANDBOX_BACKEND must be one of auto, docker, microsandbox, or vercel.",
    );
  }
  if (environment.NODE_ENV === "production" && configured === "auto") {
    throw new Error(
      "AGENT_SANDBOX_BACKEND must explicitly select docker, microsandbox, or vercel in production.",
    );
  }
  return configured as AgentSandboxBackendName;
}

export function readAgentSandboxImage(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = environment.AGENT_SANDBOX_IMAGE?.trim();
  if (!value) return undefined;
  if (/\s/u.test(value) || value.length > 512) {
    throw new Error("AGENT_SANDBOX_IMAGE must be one bounded OCI image reference.");
  }
  return value;
}

export function readAgentDeploymentTenancy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentDeploymentTenancy {
  const configured = environment.AGENT_DEPLOYMENT_TENANCY?.trim();
  if (!configured || !DEPLOYMENT_TENANCIES.has(configured as AgentDeploymentTenancy)) {
    throw new Error(
      "AGENT_DEPLOYMENT_TENANCY must explicitly be single-tenant or multi-tenant.",
    );
  }
  return configured as AgentDeploymentTenancy;
}

export function inspectProductionConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  nodeVersion = process.versions.node,
): readonly ProductionDiagnostic[] {
  const diagnostics: ProductionDiagnostic[] = [];
  const error = (code: string, message: string) => diagnostics.push({ code, level: "error", message });
  const warning = (code: string, message: string) => diagnostics.push({ code, level: "warning", message });

  if (environment.AGENT_EVAL_FIXTURE_MODEL?.trim()) {
    error(
      "eval-fixture-model",
      "AGENT_EVAL_FIXTURE_MODEL is test-only and must not be configured in production.",
    );
  }
  if (environment.AGENT_EVAL_CONTEXT_WINDOW_TOKENS?.trim()) {
    error(
      "eval-context-window",
      "AGENT_EVAL_CONTEXT_WINDOW_TOKENS is test-only and must not be configured in production.",
    );
  }
  if (environment.AGENT_PROVIDER_MODE?.trim() === "mock") {
    error(
      "mock-provider",
      "AGENT_PROVIDER_MODE=mock is test-only and must not be configured in production.",
    );
  }
  try {
    const approvalMode = environment.AGENT_BASH_APPROVAL_MODE?.trim() || "risky";
    if (approvalMode !== "always" && approvalMode !== "risky" && approvalMode !== "never") {
      throw new Error("invalid mode");
    }
    if (approvalMode === "never") {
      error(
        "bash-approval-mode",
        "AGENT_BASH_APPROVAL_MODE=never is not allowed in production.",
      );
    }
  } catch {
    error(
      "bash-approval-mode",
      "AGENT_BASH_APPROVAL_MODE must be always or risky in production.",
    );
  }

  const nodeMajor = Number(nodeVersion.split(".")[0]);
  if (nodeMajor !== 24) {
    error("node-version", `Node.js 24 is required; current version is ${nodeVersion}.`);
  }

  requireValue(environment, "OPENAI_API_KEY", error);
  requireValue(environment, "AGENT_MODEL_MAX_OUTPUT_TOKENS", error);
  requireValue(environment, "AGENT_PROVIDER_HTTP_TIMEOUT_MS", error);
  requireValue(environment, "AGENT_DATABASE_URL", error);
  requireValue(environment, "AGENT_DEPLOYMENT_TENANCY", error);
  requireValue(environment, "AGENT_RUNTIME_URL", error);
  requireValue(environment, "AGENT_SANDBOX_IMAGE", error);
  requireValue(environment, "AGENT_HOST_JWT_SECRET", error);
  requireValue(environment, "AGENT_HOST_JWT_ISSUER", error);
  requireValue(environment, "AGENT_HOST_JWT_AUDIENCE", error);
  requireValue(environment, "AGENT_MAILBOX_DISPATCH_SECRET", error);
  requireValue(environment, "AGENT_MAILBOX_WORKER_SECRET", error);
  requireValue(environment, "AGENT_EMBED_ALLOWED_ORIGINS", error);
  requireValue(environment, "AGENT_PUBLIC_BASE_URL", error);
  requireValue(environment, "AGENT_PREVIEW_SIGNING_SECRET", error);
  const assetBackend = environment.AGENT_ASSET_STORAGE_BACKEND?.trim().toLowerCase();
  if (assetBackend !== "host" && assetBackend !== "external" && assetBackend !== "s3" && assetBackend !== "object-store" && assetBackend !== "object_store") {
    error(
      "asset-storage-backend",
      "Production assets require AGENT_ASSET_STORAGE_BACKEND=s3 with S3 credentials, or a configured host AssetStore adapter.",
    );
  }
  if (assetBackend === "s3" || assetBackend === "object-store" || assetBackend === "object_store") {
    requireConfiguredValue(environment.AGENT_ASSET_S3_BUCKET || environment.S3_BUCKET, "AGENT_ASSET_S3_BUCKET", error);
    requireConfiguredValue(environment.AGENT_ASSET_S3_ACCESS_KEY_ID || environment.S3_ACCESS_KEY_ID, "AGENT_ASSET_S3_ACCESS_KEY_ID", error);
    requireConfiguredValue(environment.AGENT_ASSET_S3_SECRET_ACCESS_KEY || environment.S3_SECRET_ACCESS_KEY, "AGENT_ASSET_S3_SECRET_ACCESS_KEY", error);
    inspectAssetQuota(environment.AGENT_ASSET_QUOTA_BYTES, error);
    const scanMode = environment.AGENT_ASSET_SCAN_MODE?.trim().toLowerCase();
    if (scanMode === "disabled") {
      error(
        "asset-scanner",
        "AGENT_ASSET_SCAN_MODE=disabled is not allowed for production S3 assets; register a host AssetScanner.",
      );
    } else if (scanMode && scanMode !== "required") {
      error("asset-scanner", "AGENT_ASSET_SCAN_MODE must be required in production S3 deployments.");
    }
  }
  requireValue(environment, "WORKFLOW_POSTGRES_URL", error);
  requireValue(environment, "WORKFLOW_POSTGRES_JOB_PREFIX", error);

  let deploymentTenancy: AgentDeploymentTenancy | undefined;
  try {
    deploymentTenancy = readAgentDeploymentTenancy(environment);
  } catch (cause) {
    error(
      "deployment-tenancy",
      cause instanceof Error ? cause.message : "Invalid deployment tenancy.",
    );
  }

  const telemetryConfigured = Boolean(
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
      environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      environment.VERCEL_OTEL_ENDPOINTS?.trim(),
  );
  if (!telemetryConfigured) {
    error(
      "telemetry-exporter",
      "Configure an OTLP traces endpoint or the Vercel OTel collector for production.",
    );
  }
  inspectHttpUrl(
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    { allowLoopbackHttp: true },
    error,
  );
  inspectHttpUrl(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT,
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    { allowLoopbackHttp: true },
    error,
  );

  const jwtSecret = environment.AGENT_HOST_JWT_SECRET?.trim();
  if (jwtSecret && Buffer.byteLength(jwtSecret) < 32) {
    error("host-jwt-secret", "AGENT_HOST_JWT_SECRET must contain at least 32 bytes.");
  }

  for (const [name, code] of [
    ["AGENT_MAILBOX_DISPATCH_SECRET", "mailbox-dispatch-secret"],
    ["AGENT_MAILBOX_WORKER_SECRET", "mailbox-worker-secret"],
  ] as const) {
    const secret = environment[name]?.trim();
    if (secret && Buffer.byteLength(secret) < 32) {
      error(code, `${name} must contain at least 32 bytes.`);
    }
  }

  inspectInteger(
    environment.AGENT_MAILBOX_WORKER_INTERVAL_MS,
    "AGENT_MAILBOX_WORKER_INTERVAL_MS",
    250,
    60_000,
    error,
  );
  inspectInteger(
    environment.AGENT_ASSET_CLEANUP_INTERVAL_MS,
    "AGENT_ASSET_CLEANUP_INTERVAL_MS",
    60_000,
    86_400_000,
    error,
  );
  inspectInteger(
    environment.AGENT_ASSET_CLEANUP_LIMIT,
    "AGENT_ASSET_CLEANUP_LIMIT",
    1,
    10_000,
    error,
  );
  inspectOptionalInteger(
    environment.AGENT_DATABASE_CONNECTION_TIMEOUT_MS,
    "AGENT_DATABASE_CONNECTION_TIMEOUT_MS",
    100,
    300_000,
    error,
  );
  inspectOptionalInteger(
    environment.AGENT_DATABASE_IDLE_TIMEOUT_MS,
    "AGENT_DATABASE_IDLE_TIMEOUT_MS",
    100,
    300_000,
    error,
  );

  const algorithm = environment.AGENT_HOST_JWT_ALGORITHM?.trim() || "HS256";
  if (algorithm !== "HS256") {
    error("host-jwt-algorithm", "Only AGENT_HOST_JWT_ALGORITHM=HS256 is currently supported.");
  }

  const schema = environment.AGENT_DATABASE_SCHEMA?.trim() || "open_agent";
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema) || schema.toLowerCase() === "workflow") {
    error(
      "agent-database-schema",
      "AGENT_DATABASE_SCHEMA must be a valid non-workflow PostgreSQL schema name.",
    );
  }

  const agentDatabase = postgresDatabaseIdentity(environment.AGENT_DATABASE_URL, "AGENT_DATABASE_URL", error);
  const workflowDatabase = postgresDatabaseIdentity(
    environment.WORKFLOW_POSTGRES_URL,
    "WORKFLOW_POSTGRES_URL",
    error,
  );
  if (agentDatabase && workflowDatabase && agentDatabase === workflowDatabase) {
    error(
      "workflow-world-isolation",
      "The Eve Workflow World must use a physically separate PostgreSQL database from AGENT_DATABASE_URL.",
    );
  }

  if (environment.WORKFLOW_TARGET_WORLD?.trim() !== "@workflow/world-postgres") {
    error(
      "workflow-world",
      "WORKFLOW_TARGET_WORLD must be @workflow/world-postgres for the supported self-hosted production topology.",
    );
  }

  const jobPrefix = environment.WORKFLOW_POSTGRES_JOB_PREFIX?.trim();
  if (jobPrefix === "muses_" || jobPrefix === "workflow_") {
    error(
      "workflow-job-prefix",
      "WORKFLOW_POSTGRES_JOB_PREFIX must not reuse the Muses or default Workflow queue prefix.",
    );
  } else if (jobPrefix && jobPrefix !== "open_agent_") {
    warning(
      "workflow-job-prefix-convention",
      "The verified Open Agent queue prefix is open_agent_; keep custom prefixes unique per Workflow World.",
    );
  }

  try {
    const backend = readAgentSandboxBackend({ ...environment, NODE_ENV: "production" });
    const image = readAgentSandboxImage(environment);
    try {
      readAgentSandboxWorkspaceQuota(environment);
    } catch (cause) {
      error("sandbox-workspace-quota", cause instanceof Error ? cause.message : "Invalid sandbox workspace quota.");
    }
    if (image && !/@sha256:[a-f0-9]{64}$/u.test(image)) {
      error(
        "sandbox-image",
        "AGENT_SANDBOX_IMAGE must use an immutable OCI sha256 digest in production.",
      );
    }
    if (backend === "docker") {
      try {
        readAgentDockerResourceLimits(environment);
      } catch (cause) {
        error(
          "docker-resource-limits",
          cause instanceof Error ? cause.message : "Invalid Docker sandbox resource limits.",
        );
      }
      inspectInteger(
        environment.EVE_SANDBOX_RETENTION_HOURS,
        "EVE_SANDBOX_RETENTION_HOURS",
        1,
        87_600,
        error,
      );
      inspectInteger(
        environment.EVE_SANDBOX_REAPER_MAX_REMOVALS,
        "EVE_SANDBOX_REAPER_MAX_REMOVALS",
        1,
        10_000,
        error,
      );
      inspectInteger(
        environment.AGENT_SANDBOX_TERMINAL_RETENTION_HOURS,
        "AGENT_SANDBOX_TERMINAL_RETENTION_HOURS",
        1,
        87_600,
        error,
      );
      inspectInteger(
        environment.AGENT_SANDBOX_CLEANUP_INTERVAL_MS,
        "AGENT_SANDBOX_CLEANUP_INTERVAL_MS",
        1_000,
        86_400_000,
        error,
      );
      inspectInteger(
        environment.AGENT_SANDBOX_CLEANUP_MAX_SESSIONS,
        "AGENT_SANDBOX_CLEANUP_MAX_SESSIONS",
        1,
        10_000,
        error,
      );
      if (deploymentTenancy === "multi-tenant") {
        error(
          "sandbox-backend-docker-multi-tenant",
          "Eve's Docker backend does not expose the resource, capability, or VM isolation controls required for untrusted multi-tenant production. Select microsandbox, Vercel Sandbox, or another reviewed microVM backend.",
        );
      } else if (deploymentTenancy === "single-tenant") {
        warning(
          "sandbox-backend-docker",
          "Docker is selected for a single-tenant deployment; schedule the sandbox reaper and prove daemon hardening, quotas, and cross-session isolation on the deployed host.",
        );
      }
    }
  } catch (cause) {
    error("sandbox-backend", cause instanceof Error ? cause.message : "Invalid sandbox backend.");
  }

  inspectHttpUrl(environment.AGENT_RUNTIME_URL, "AGENT_RUNTIME_URL", { allowLoopbackHttp: true }, error);
  inspectHttpUrl(environment.AGENT_PUBLIC_BASE_URL, "AGENT_PUBLIC_BASE_URL", { allowLoopbackHttp: false }, error);
  const publicBaseUrl = environment.AGENT_PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) {
    try {
      const parsed = new URL(publicBaseUrl);
      if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        error(
          "preview-public-base-url",
          "AGENT_PUBLIC_BASE_URL must be an HTTPS origin without a path, query, or fragment.",
        );
      }
    } catch {
      // inspectHttpUrl emits the canonical URL diagnostic.
    }
  }
  const previewSigningSecret = environment.AGENT_PREVIEW_SIGNING_SECRET?.trim();
  if (previewSigningSecret && Buffer.byteLength(previewSigningSecret) < 32) {
    error(
      "preview-signing-secret",
      "AGENT_PREVIEW_SIGNING_SECRET must contain at least 32 bytes.",
    );
  }
  inspectHttpUrl(environment.OPENAI_BASE_URL, "OPENAI_BASE_URL", { allowLoopbackHttp: true }, error);
  inspectInteger(
    environment.AGENT_MODEL_MAX_OUTPUT_TOKENS,
    "AGENT_MODEL_MAX_OUTPUT_TOKENS",
    256,
    128_000,
    error,
  );
  inspectInteger(
    environment.AGENT_PROVIDER_HTTP_TIMEOUT_MS,
    "AGENT_PROVIDER_HTTP_TIMEOUT_MS",
    1_000,
    900_000,
    error,
  );

  const hostToolsUrl = environment.AGENT_HOST_TOOLS_URL?.trim();
  const hostToolsSecret = environment.AGENT_HOST_TOOLS_SECRET?.trim();
  if (Boolean(hostToolsUrl) !== Boolean(hostToolsSecret)) {
    error(
      "host-tools-pair",
      "AGENT_HOST_TOOLS_URL and AGENT_HOST_TOOLS_SECRET must be configured together.",
    );
  }
  if (hostToolsUrl) {
    inspectHttpUrl(hostToolsUrl, "AGENT_HOST_TOOLS_URL", { allowLoopbackHttp: true }, error);
  }
  if (hostToolsSecret && Buffer.byteLength(hostToolsSecret) < 32) {
    error("host-tools-secret", "AGENT_HOST_TOOLS_SECRET must contain at least 32 bytes.");
  }

  inspectFrameOrigins(environment.AGENT_EMBED_ALLOWED_ORIGINS, error);
  inspectInteger(environment.EVE_NEXT_PRODUCTION_PORT, "EVE_NEXT_PRODUCTION_PORT", 1, 65_535, error);
  inspectInteger(
    environment.WORKFLOW_POSTGRES_WORKER_CONCURRENCY,
    "WORKFLOW_POSTGRES_WORKER_CONCURRENCY",
    1,
    1_000,
    error,
  );
  inspectInteger(
    environment.WORKFLOW_POSTGRES_MAX_POOL_SIZE,
    "WORKFLOW_POSTGRES_MAX_POOL_SIZE",
    1,
    1_000,
    error,
  );
  inspectInteger(
    environment.AGENT_MAX_ACTIVE_RUNS_TOTAL,
    "AGENT_MAX_ACTIVE_RUNS_TOTAL",
    1,
    10_000,
    error,
  );
  inspectInteger(
    environment.AGENT_MAX_ACTIVE_RUNS_PER_TENANT,
    "AGENT_MAX_ACTIVE_RUNS_PER_TENANT",
    1,
    10_000,
    error,
  );
  inspectOptionalInteger(
    environment.AGENT_RUN_RECONCILE_INTERVAL_MS,
    "AGENT_RUN_RECONCILE_INTERVAL_MS",
    1_000,
    86_400_000,
    error,
  );
  inspectOptionalInteger(
    environment.AGENT_RUN_RECONCILE_LIMIT,
    "AGENT_RUN_RECONCILE_LIMIT",
    1,
    10_000,
    error,
  );
  inspectOptionalInteger(
    environment.AGENT_RUN_SUBMISSION_STALE_MS,
    "AGENT_RUN_SUBMISSION_STALE_MS",
    10_000,
    86_400_000,
    error,
  );

  const revoked = environment.AGENT_REVOKED_EXTENSIONS?.trim();
  if (revoked) {
    for (const reference of revoked.split(",").map((value) => value.trim())) {
      if (!EXTENSION_REF.test(reference)) {
        error(
          "revoked-extension-ref",
          `AGENT_REVOKED_EXTENSIONS contains invalid version-pinned reference ${JSON.stringify(reference)}.`,
        );
      }
    }
  }

  return diagnostics;
}

function requireValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  error: (code: string, message: string) => void,
): void {
  if (!environment[name]?.trim()) {
    error("missing-required", `${name} is required for production.`);
  }
}

function requireConfiguredValue(
  value: string | undefined,
  name: string,
  error: (code: string, message: string) => void,
): void {
  if (!value?.trim()) error("missing-required", `${name} is required for production.`);
}

function inspectOptionalInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  error: (code: string, message: string) => void,
): void {
  if (!value?.trim()) return;
  inspectInteger(value, name, minimum, maximum, error);
}

function postgresDatabaseIdentity(
  value: string | undefined,
  name: string,
  error: (code: string, message: string) => void,
): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
    const database = url.pathname.replace(/^\/+/, "");
    if (!url.hostname || !database) throw new Error("missing host or database");
    const port = url.port || "5432";
    return `${url.hostname.toLowerCase()}:${port}/${database}`;
  } catch {
    error("postgres-url", `${name} must be a PostgreSQL URL containing an explicit database name.`);
    return undefined;
  }
}

function inspectHttpUrl(
  value: string | undefined,
  name: string,
  options: { readonly allowLoopbackHttp: boolean },
  error: (code: string, message: string) => void,
): void {
  if (!value?.trim()) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(options.allowLoopbackHttp && loopback)) {
      error("insecure-url", `${name} must use HTTPS outside an explicit loopback topology.`);
    }
  } catch {
    error("http-url", `${name} must be an absolute HTTP(S) URL.`);
  }
}

function inspectFrameOrigins(
  value: string | undefined,
  error: (code: string, message: string) => void,
): void {
  if (!value?.trim()) return;
  const origins = value.split(",").map((origin) => origin.trim());
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (url.origin !== origin || (url.protocol !== "https:" && !loopback)) {
        throw new Error("origin");
      }
    } catch {
      error(
        "embed-origin",
        `AGENT_EMBED_ALLOWED_ORIGINS contains invalid exact origin ${JSON.stringify(origin)}.`,
      );
    }
  }
}

function inspectInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  error: (code: string, message: string) => void,
): void {
  if (!value?.trim()) {
    error("missing-required", `${name} is required for production.`);
    return;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    error("integer-range", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function inspectAssetQuota(
  value: string | undefined,
  error: (code: string, message: string) => void,
): void {
  if (!value?.trim()) {
    error("asset-quota", "AGENT_ASSET_QUOTA_BYTES is required for production S3 assets.");
    return;
  }
  const match = /^(\d+)(?:\s*(KiB|MiB|GiB|TiB))?$/iu.exec(value.trim());
  if (!match) {
    error("asset-quota", "AGENT_ASSET_QUOTA_BYTES must be a positive byte count with an optional KiB, MiB, GiB, or TiB suffix.");
    return;
  }
  const multiplier = match[2]?.toLowerCase() === "kib"
    ? 1024
    : match[2]?.toLowerCase() === "mib"
      ? 1024 ** 2
      : match[2]?.toLowerCase() === "gib"
        ? 1024 ** 3
        : match[2]?.toLowerCase() === "tib"
          ? 1024 ** 4
          : 1;
  const bytes = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 10 * 1024 ** 4) {
    error("asset-quota", "AGENT_ASSET_QUOTA_BYTES must be between 1 byte and 10 TiB.");
  }
}
