import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectProductionConfiguration,
  readAgentDockerResourceLimits,
  readAgentSandboxAdmissionConfig,
  readAgentDeploymentTenancy,
  readAgentSandboxBackend,
  readAgentSandboxIdleTimeoutMs,
  readAgentSandboxWorkspaceQuota,
} from "../../lib/production-config.ts";
import { readAgentDatabaseConfig } from "../../server/data/agent-database.ts";
import {
  readAgentEvalContextWindowTokens,
  readAgentModelMaxOutputTokens,
} from "../../lib/agent-profile.ts";

const validEnvironment = {
  AGENT_DATABASE_SCHEMA: "open_agent",
  AGENT_DATABASE_URL: "postgresql://agent:secret@db.internal:5432/muses_product",
  AGENT_DATABASE_CONNECTION_TIMEOUT_MS: "10000",
  AGENT_DATABASE_IDLE_TIMEOUT_MS: "30000",
  AGENT_DEPLOYMENT_TENANCY: "multi-tenant",
  AGENT_SANDBOX_IDLE_TIMEOUT_MS: "1800000",
  AGENT_EMBED_ALLOWED_ORIGINS: "https://muses.example.com",
  AGENT_HOST_JWT_ALGORITHM: "HS256",
  AGENT_HOST_JWT_AUDIENCE: "open-agent",
  AGENT_HOST_JWT_ISSUER: "https://muses.example.com",
  AGENT_HOST_JWT_SECRET: "a-production-secret-at-least-32-bytes-long",
  AGENT_MAILBOX_DISPATCH_SECRET: "a-mailbox-dispatch-secret-at-least-32-bytes",
  AGENT_MAILBOX_WORKER_INTERVAL_MS: "1000",
  AGENT_MAILBOX_WORKER_SECRET: "a-mailbox-worker-secret-at-least-32-bytes-long",
  AGENT_MODEL_MAX_OUTPUT_TOKENS: "4096",
  AGENT_PREVIEW_SIGNING_SECRET: "preview-signing-secret-at-least-32-bytes-long",
  AGENT_METRICS_SECRET: "metrics-secret-at-least-32-bytes-long",
  AGENT_PUBLIC_BASE_URL: "https://agent.example.com",
  AGENT_PROVIDER_HTTP_TIMEOUT_MS: "120000",
  AGENT_RUNTIME_URL: "https://agent-runtime.example.com",
  AGENT_SANDBOX_BACKEND: "microsandbox",
  AGENT_SANDBOX_MAX_ACTIVE: "16",
  AGENT_SANDBOX_ADMISSION_TIMEOUT_MS: "30000",
  AGENT_SANDBOX_IMAGE: "ghcr.io/oworker/open-agent-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  AGENT_SANDBOX_CLEANUP_INTERVAL_MS: "900000",
  AGENT_SANDBOX_CLEANUP_MAX_SESSIONS: "25",
  AGENT_BASH_APPROVAL_MODE: "risky",
  AGENT_ASSET_STORAGE_BACKEND: "host",
  AGENT_ASSET_CLEANUP_INTERVAL_MS: "3600000",
  AGENT_ASSET_CLEANUP_LIMIT: "100",
  AGENT_MAX_ACTIVE_RUNS_TOTAL: "16",
  AGENT_MAX_ACTIVE_RUNS_PER_TENANT: "8",
  EVE_NEXT_PRODUCTION_PORT: "4275",
  NODE_ENV: "production",
  OPENAI_API_KEY: "provider-key",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/v1/traces",
  WORKFLOW_POSTGRES_JOB_PREFIX: "open_agent_",
  WORKFLOW_POSTGRES_MAX_POOL_SIZE: "22",
  WORKFLOW_POSTGRES_URL: "postgresql://agent:secret@db.internal:5432/open_agent_world",
  WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "20",
  WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
} as const;

test("accepts the verified production topology", () => {
  assert.deepEqual(inspectProductionConfiguration(validEnvironment, "24.18.1"), []);
});

test("requires finite AgentRun admission limits in production", () => {
  assert.deepEqual(inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_MAX_ACTIVE_RUNS_TOTAL: "16",
    AGENT_MAX_ACTIVE_RUNS_PER_TENANT: "8",
  }, "24.18.1"), []);
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_MAX_ACTIVE_RUNS_TOTAL: "10001",
    AGENT_MAX_ACTIVE_RUNS_PER_TENANT: "-1",
  }, "24.18.1");
  assert.equal(
    diagnostics.filter((item) => item.code === "integer-range").length,
    2,
  );
  const missing = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_MAX_ACTIVE_RUNS_TOTAL: undefined,
    AGENT_MAX_ACTIVE_RUNS_PER_TENANT: undefined,
  }, "24.18.1");
  assert.equal(
    missing.filter((item) => item.code === "missing-required").length,
    2,
  );
});

test("database pool timeouts are bounded and defaulted", () => {
  const defaults = readAgentDatabaseConfig({ AGENT_DATABASE_URL: "postgresql://agent:secret@db.internal:5432/open_agent" });
  assert.equal(defaults?.connectionTimeoutMillis, 10_000);
  assert.equal(defaults?.idleTimeoutMillis, 30_000);
  const configured = readAgentDatabaseConfig({
    AGENT_DATABASE_URL: "postgresql://agent:secret@db.internal:5432/open_agent",
    AGENT_DATABASE_CONNECTION_TIMEOUT_MS: "5000",
    AGENT_DATABASE_IDLE_TIMEOUT_MS: "60000",
  });
  assert.equal(configured?.connectionTimeoutMillis, 5_000);
  assert.equal(configured?.idleTimeoutMillis, 60_000);
  assert.throws(
    () => readAgentDatabaseConfig({
      AGENT_DATABASE_URL: "postgresql://agent:secret@db.internal:5432/open_agent",
      AGENT_DATABASE_CONNECTION_TIMEOUT_MS: "50",
    }),
    /AGENT_DATABASE_CONNECTION_TIMEOUT_MS/,
  );
});

test("run reconciliation settings reject unsafe ranges", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_RUN_RECONCILE_INTERVAL_MS: "999",
    AGENT_RUN_RECONCILE_LIMIT: "0",
    AGENT_RUN_SUBMISSION_STALE_MS: "9999",
  }, "24.18.1");
  assert.equal(
    diagnostics.filter((item) => item.code === "integer-range").length,
    3,
  );
});

test("accepts the built-in S3 AssetStore production topology", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_ASSET_STORAGE_BACKEND: "s3",
    AGENT_ASSET_S3_BUCKET: "open-agent-assets",
    AGENT_ASSET_S3_ACCESS_KEY_ID: "s3-access",
    AGENT_ASSET_S3_SECRET_ACCESS_KEY: "s3-secret",
    AGENT_ASSET_QUOTA_BYTES: "100GiB",
  }, "24.18.1");
  assert.deepEqual(diagnostics, []);
});

test("rejects an S3 AssetStore without object-store credentials", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_ASSET_STORAGE_BACKEND: "s3",
    AGENT_ASSET_S3_BUCKET: "open-agent-assets",
  }, "24.18.1");
  assert.ok(diagnostics.some((item) => item.code === "missing-required" && item.message.includes("AGENT_ASSET_S3_ACCESS_KEY_ID")));
  assert.ok(diagnostics.some((item) => item.code === "missing-required" && item.message.includes("AGENT_ASSET_S3_SECRET_ACCESS_KEY")));
});

test("rejects disabled asset scanning for production S3", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_ASSET_STORAGE_BACKEND: "s3",
    AGENT_ASSET_S3_BUCKET: "open-agent-assets",
    AGENT_ASSET_S3_ACCESS_KEY_ID: "s3-access",
    AGENT_ASSET_S3_SECRET_ACCESS_KEY: "s3-secret",
    AGENT_ASSET_QUOTA_BYTES: "100GiB",
    AGENT_ASSET_SCAN_MODE: "disabled",
  }, "24.18.1");
  assert.ok(diagnostics.some((item) => item.code === "asset-scanner"));
});

test("rejects an implicit production sandbox and shared Workflow database", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_SANDBOX_BACKEND: "auto",
    WORKFLOW_POSTGRES_URL: validEnvironment.AGENT_DATABASE_URL,
  }, "22.22.0");
  const codes = diagnostics.filter((diagnostic) => diagnostic.level === "error").map((item) => item.code);
  assert.ok(codes.includes("node-version"));
  assert.ok(codes.includes("sandbox-backend"));
  assert.ok(codes.includes("workflow-world-isolation"));
});

test("rejects insecure origins, partial Host tools, and colliding queue prefix", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_EMBED_ALLOWED_ORIGINS: "http://muses.example.com/path",
    AGENT_HOST_TOOLS_URL: "https://muses.example.com/api/studio/agent-host-tools",
    WORKFLOW_POSTGRES_JOB_PREFIX: "muses_",
  }, "24.18.1");
  const codes = diagnostics.filter((diagnostic) => diagnostic.level === "error").map((item) => item.code);
  assert.ok(codes.includes("embed-origin"));
  assert.ok(codes.includes("host-tools-pair"));
  assert.ok(codes.includes("workflow-job-prefix"));
});

test("allows automatic sandbox discovery only outside production", () => {
  assert.equal(readAgentSandboxBackend({ NODE_ENV: "development" }), "auto");
  assert.throws(
    () => readAgentSandboxBackend({ NODE_ENV: "production" }),
    /must explicitly select/,
  );
});

test("bounds the logical sandbox import quota", () => {
  assert.equal(readAgentSandboxWorkspaceQuota({}), 10 * 1024 ** 3);
  assert.equal(
    readAgentSandboxWorkspaceQuota({ AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES: "512MiB" }),
    512 * 1024 ** 2,
  );
  assert.throws(
    () => readAgentSandboxWorkspaceQuota({ AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES: "0" }),
    /between 1 byte/u,
  );
  assert.throws(
    () => readAgentSandboxWorkspaceQuota({ AGENT_SANDBOX_WORKSPACE_QUOTA_BYTES: "not-a-size" }),
    /positive byte count/u,
  );
});

test("parses bounded Docker sandbox resource limits", () => {
  assert.deepEqual(
    readAgentDockerResourceLimits({
      AGENT_DOCKER_MEMORY_LIMIT_BYTES: "1GiB",
      AGENT_DOCKER_CPU_LIMIT: "1.5",
      AGENT_DOCKER_PIDS_LIMIT: "256",
    }),
    { memoryBytes: 1024 ** 3, cpus: 1.5, pidsLimit: 256 },
  );
  assert.deepEqual(readAgentDockerResourceLimits({}), {
    memoryBytes: 2 * 1024 ** 3,
    cpus: 2,
    pidsLimit: 512,
  });
  assert.throws(
    () => readAgentDockerResourceLimits({ NODE_ENV: "production" }),
    /must be explicitly configured in production/u,
  );
  assert.throws(
    () => readAgentDockerResourceLimits({ AGENT_DOCKER_MEMORY_LIMIT_BYTES: "32MiB" }),
    /AGENT_DOCKER_MEMORY_LIMIT_BYTES/u,
  );
  assert.throws(
    () => readAgentDockerResourceLimits({ AGENT_DOCKER_CPU_LIMIT: "0" }),
    /AGENT_DOCKER_CPU_LIMIT/u,
  );
  assert.throws(
    () => readAgentDockerResourceLimits({ AGENT_DOCKER_PIDS_LIMIT: "32" }),
    /AGENT_DOCKER_PIDS_LIMIT/u,
  );
});

test("bounds idle compute shutdown without expiring the durable session", () => {
  assert.equal(readAgentSandboxIdleTimeoutMs({}), 30 * 60 * 1_000);
  assert.equal(
    readAgentSandboxIdleTimeoutMs({ AGENT_SANDBOX_IDLE_TIMEOUT_MS: "60000" }),
    60_000,
  );
  assert.throws(
    () => readAgentSandboxIdleTimeoutMs({ NODE_ENV: "production" }),
    /must be explicitly configured/u,
  );
  assert.throws(
    () => readAgentSandboxIdleTimeoutMs({ AGENT_SANDBOX_IDLE_TIMEOUT_MS: "59999" }),
    /AGENT_SANDBOX_IDLE_TIMEOUT_MS/u,
  );
  assert.equal(
    readAgentSandboxIdleTimeoutMs({ AGENT_DOCKER_IDLE_TIMEOUT_MS: "60000" }),
    60_000,
  );
});

test("requires bounded host-wide sandbox admission in production", () => {
  assert.deepEqual(readAgentSandboxAdmissionConfig({}), { maxActive: 2, timeoutMs: 30_000 });
  assert.deepEqual(readAgentSandboxAdmissionConfig({
    AGENT_SANDBOX_MAX_ACTIVE: "8",
    AGENT_SANDBOX_ADMISSION_TIMEOUT_MS: "45000",
  }), { maxActive: 8, timeoutMs: 45_000 });
  assert.throws(
    () => readAgentSandboxAdmissionConfig({ NODE_ENV: "production" }),
    /must be explicitly configured/u,
  );
  assert.throws(
    () => readAgentSandboxAdmissionConfig({ AGENT_SANDBOX_MAX_ACTIVE: "0" }),
    /AGENT_SANDBOX_MAX_ACTIVE/u,
  );
});

test("requires an explicit deployment tenancy", () => {
  assert.equal(readAgentDeploymentTenancy(validEnvironment), "multi-tenant");
  assert.throws(
    () => readAgentDeploymentTenancy({}),
    /must explicitly be single-tenant or multi-tenant/,
  );
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_DEPLOYMENT_TENANCY: "shared",
  }, "24.18.1");
  assert.ok(diagnostics.some((item) => item.code === "deployment-tenancy"));
});

test("requires an explicit Docker sandbox retention policy", () => {
  const missing = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_DEPLOYMENT_TENANCY: "single-tenant",
    AGENT_SANDBOX_BACKEND: "docker",
  }, "24.18.1");
  assert.equal(
    missing.filter((item) => item.code === "missing-required" && item.level === "error").length,
    2,
  );
  assert.ok(missing.some((item) => item.code === "docker-resource-limits" && item.level === "error"));

  const valid = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_DEPLOYMENT_TENANCY: "single-tenant",
    AGENT_SANDBOX_BACKEND: "docker",
    AGENT_DOCKER_MEMORY_LIMIT_BYTES: "2GiB",
    AGENT_DOCKER_CPU_LIMIT: "2",
    AGENT_DOCKER_PIDS_LIMIT: "512",
    EVE_SANDBOX_REAPER_MAX_REMOVALS: "50",
    EVE_SANDBOX_RETENTION_HOURS: "168",
  }, "24.18.1");
  assert.equal(valid.some((item) => item.level === "error"), false);
  assert.ok(valid.some((item) => item.code === "sandbox-backend-docker"));
});

test("rejects Docker for untrusted multi-tenant production", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_SANDBOX_BACKEND: "docker",
    EVE_SANDBOX_REAPER_MAX_REMOVALS: "50",
    EVE_SANDBOX_RETENTION_HOURS: "168",
  }, "24.18.1");
  assert.ok(
    diagnostics.some(
      (item) => item.code === "sandbox-backend-docker-multi-tenant" && item.level === "error",
    ),
  );
});

test("requires an immutable production sandbox image", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_SANDBOX_IMAGE: "ghcr.io/oworker/open-agent-sandbox:latest",
  }, "24.18.1");
  assert.ok(diagnostics.some((item) => item.code === "sandbox-image" && item.level === "error"));
});

test("rejects fixture models and disabled Shell approval in production", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_BASH_APPROVAL_MODE: "never",
    AGENT_EVAL_CONTEXT_WINDOW_TOKENS: "4096",
    AGENT_EVAL_FIXTURE_MODEL: "autonomy-v1",
  }, "24.18.1");
  const codes = diagnostics
    .filter((diagnostic) => diagnostic.level === "error")
    .map((diagnostic) => diagnostic.code);
  assert.ok(codes.includes("bash-approval-mode"));
  assert.ok(codes.includes("eval-context-window"));
  assert.ok(codes.includes("eval-fixture-model"));
});

test("rejects an explicitly mocked Provider in production", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_PROVIDER_MODE: "mock",
  }, "24.0.0");
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "mock-provider"));
});

test("allows a loopback Muses Provider broker but rejects plaintext remote Providers", () => {
  const loopback = inspectProductionConfiguration({
    ...validEnvironment,
    OPENAI_BASE_URL: "http://127.0.0.1:4730/api/internal/agent-provider/v1",
  }, "24.0.0");
  assert.equal(loopback.some((diagnostic) => diagnostic.code === "insecure-url"), false);

  const remote = inspectProductionConfiguration({
    ...validEnvironment,
    OPENAI_BASE_URL: "http://muses.internal/api/internal/agent-provider/v1",
  }, "24.0.0");
  assert.ok(remote.some((diagnostic) => diagnostic.code === "insecure-url"));
});

test("bounds the test-only context window override", () => {
  assert.equal(readAgentEvalContextWindowTokens({}), 272_000);
  assert.equal(
    readAgentEvalContextWindowTokens({ AGENT_EVAL_CONTEXT_WINDOW_TOKENS: "4096" }),
    4_096,
  );
  assert.throws(
    () => readAgentEvalContextWindowTokens({ AGENT_EVAL_CONTEXT_WINDOW_TOKENS: "1024" }),
    /must be an integer from 2048 to 2000000/,
  );
});

test("requires a bounded provider HTTP timeout", () => {
  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_PROVIDER_HTTP_TIMEOUT_MS: "0",
  }, "24.18.1");
  assert.ok(
    diagnostics.some(
      (diagnostic) => diagnostic.code === "integer-range" && diagnostic.level === "error",
    ),
  );
});

test("requires a secure preview origin and signing secret", () => {
  const missing = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_PUBLIC_BASE_URL: "",
    AGENT_PREVIEW_SIGNING_SECRET: "short",
  }, "24.18.1");
  assert.ok(missing.some((item) => item.code === "missing-required" && item.message.includes("AGENT_PUBLIC_BASE_URL")));
  assert.ok(missing.some((item) => item.code === "preview-signing-secret"));

  const invalid = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_PUBLIC_BASE_URL: "http://agent.example.com/preview",
  }, "24.18.1");
  assert.ok(invalid.some((item) => item.code === "insecure-url"));
  assert.ok(invalid.some((item) => item.code === "preview-public-base-url"));
});

test("uses and validates a bounded per-request model output limit", () => {
  assert.equal(readAgentModelMaxOutputTokens({}), 4_096);
  assert.equal(
    readAgentModelMaxOutputTokens({ AGENT_MODEL_MAX_OUTPUT_TOKENS: "8192" }),
    8_192,
  );
  assert.throws(
    () =>
      readAgentModelMaxOutputTokens({ AGENT_MODEL_MAX_OUTPUT_TOKENS: "200" }),
    /must be an integer from 256 to 128000/,
  );

  const diagnostics = inspectProductionConfiguration({
    ...validEnvironment,
    AGENT_MODEL_MAX_OUTPUT_TOKENS: "0",
  }, "24.18.1");
  assert.ok(
    diagnostics.some(
      (diagnostic) => diagnostic.code === "integer-range" && diagnostic.level === "error",
    ),
  );
});
