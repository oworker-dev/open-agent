import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspaceRoot = new URL("../", import.meta.url).pathname;
const temporaryRoot = await mkdtemp(join(tmpdir(), "open-agent-sdk-"));
const packageDirectory = join(temporaryRoot, "packages");
const consumerDirectory = join(temporaryRoot, "consumer");
const pnpmConsumerDirectory = join(temporaryRoot, "pnpm-consumer");
const publicPackages = [
  "@oworker/open-agent-contracts",
  "@oworker/open-agent-client",
  "@oworker/open-agent-host",
  "@oworker/open-agent-ui",
  "@oworker/open-agent-mcp-adapter",
];

try {
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
    mkdir(pnpmConsumerDirectory, { recursive: true }),
  ]);
  for (const workspace of publicPackages) {
    execFileSync(
      "npm",
      ["pack", "--silent", "--workspace", workspace, "--pack-destination", packageDirectory],
      { cwd: workspaceRoot, stdio: "pipe" },
    );
  }

  const archives = (await readdir(packageDirectory))
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(packageDirectory, file));
  assert.equal(archives.length, 5, "Expected one archive for each public SDK package.");
  const localPackageSpecs = Object.fromEntries(publicPackages.map((packageName) => {
    const archivePrefix = `${packageName.slice(1).replaceAll("/", "-")}-`;
    const archive = archives.find((path) => path.split("/").at(-1)?.startsWith(archivePrefix));
    assert.ok(archive, `Expected a packed archive for ${packageName}.`);
    return [packageName, `file:${archive}`];
  }));

  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "agent-sdk-conformance-consumer", private: true, type: "module" }),
  );
  execFileSync("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "eve@0.31.1",
    ...archives,
  ], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });

  const probe = `
    import assert from "node:assert/strict";
    import { AGENT_RUN_CONTRACT_VERSION } from "@oworker/open-agent-contracts";
    import { AGENT_SESSION_CONTRACT_VERSION } from "@oworker/open-agent-contracts/agent-session";
    import { AGENT_EMBED_CONTRACT_VERSION } from "@oworker/open-agent-contracts/embed";
    import { AGENT_CLIENT_VERSION, createAgentRunClient } from "@oworker/open-agent-client";
    import { AGENT_HOST_SIGNATURE_VERSION, signAgentHostCapabilityRequest } from "@oworker/open-agent-host";
    import { AGENT_UI_VERSION, AgentWorkspace } from "@oworker/open-agent-ui";
    import { createBrokeredMcpConnection } from "@oworker/open-agent-mcp-adapter";
    import { Button } from "@oworker/open-agent-ui/ui/button";
    assert.equal(AGENT_RUN_CONTRACT_VERSION, "0.1.0-draft");
    assert.equal(AGENT_SESSION_CONTRACT_VERSION, "0.1.0-draft");
    assert.equal(AGENT_EMBED_CONTRACT_VERSION, "0.1.0");
    assert.equal(AGENT_CLIENT_VERSION, "0.1.0-alpha.9");
    assert.equal(AGENT_HOST_SIGNATURE_VERSION, "0.2.0");
    assert.equal(AGENT_UI_VERSION, "0.1.0-alpha.9");
    assert.equal(typeof createAgentRunClient, "function");
    assert.equal(typeof signAgentHostCapabilityRequest, "function");
    assert.equal(typeof AgentWorkspace, "function");
    assert.equal(typeof createBrokeredMcpConnection, "function");
    assert.equal(typeof Button, "function");
    assert.match(import.meta.resolve("@oworker/open-agent-ui/styles.css"), /styles\.css$/);
  `;
  execFileSync("node", ["--input-type=module", "--eval", probe], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });

  await writeFile(
    join(pnpmConsumerDirectory, "package.json"),
    JSON.stringify({
      dependencies: {
        ...localPackageSpecs,
        eve: "0.31.1",
      },
      name: "agent-sdk-pnpm-conformance-consumer",
      pnpm: {
        // pnpm resolves a packed package's regular dependencies separately
        // from sibling tarballs. Point only the UI's unpublished contracts
        // dependency at the archive under test instead of the public registry.
        overrides: {
          "@oworker/open-agent-ui>@oworker/open-agent-contracts":
            localPackageSpecs["@oworker/open-agent-contracts"],
        },
      },
      private: true,
      type: "module",
    }),
  );
  execFileSync("pnpm", ["install", "--ignore-scripts"], {
    cwd: pnpmConsumerDirectory,
    stdio: "pipe",
  });
  execFileSync("node", ["--input-type=module", "--eval", probe], {
    cwd: pnpmConsumerDirectory,
    stdio: "pipe",
  });

  process.stdout.write(
    JSON.stringify({
      archives: archives.map((path) => path.split("/").at(-1)),
      consumers: ["npm", "pnpm"],
      ok: true,
    }) + "\n",
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
