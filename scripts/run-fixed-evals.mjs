import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

const executable = resolve("node_modules/eve/bin/eve.js");
const publicationRoot = mkdtempSync(join(tmpdir(), "open-agent-fixed-evals-"));
const environment = {
  ...process.env,
  AGENT_BASH_APPROVAL_MODE: "risky",
  AGENT_DATABASE_URL: "",
  AGENT_EVAL_CONTEXT_WINDOW_TOKENS: "4096",
  AGENT_EVAL_FIXTURE_MODEL: "autonomy-v1",
  AGENT_HOST_JWT_AUDIENCE: "",
  AGENT_HOST_JWT_ISSUER: "",
  AGENT_HOST_JWT_SECRET: "",
  AGENT_HOST_TOOLS_SECRET: "",
  AGENT_HOST_TOOLS_URL: "",
  AGENT_ARTIFACT_STORAGE_PATH: join(publicationRoot, "artifacts"),
  AGENT_PREVIEW_SIGNING_SECRET: "fixed-eval-preview-secret-at-least-32-bytes",
  AGENT_PREVIEW_STORAGE_PATH: join(publicationRoot, "previews"),
  AGENT_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  AGENT_SANDBOX_BACKEND: process.env.FIXED_EVAL_SANDBOX_BACKEND?.trim() || "docker",
  AGENT_SANDBOX_IMAGE:
    process.env.FIXED_EVAL_SANDBOX_IMAGE?.trim() ||
    process.env.AGENT_SANDBOX_IMAGE?.trim() ||
    "ghcr.io/oworker-dev/open-agent-sandbox:0.1.0-alpha.9@sha256:44e675839b0e4e16a97e5aceb86ef001fd379ae2642efe4d3bbead9d333f14d9",
};

const child = spawn(process.execPath, [
  executable,
  "eval",
  "fixed",
  "--strict",
  "--max-concurrency",
  "1",
  "--junit",
  ".eve/fixed-evals.junit.xml",
  ...process.argv.slice(2),
], {
  env: environment,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  rmSync(publicationRoot, { force: true, recursive: true });
  if (signal) console.error(`Fixed eval runner terminated by ${signal}.`);
  process.exitCode = code ?? 1;
});
