import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

import { closeAgentDatabasePools } from "../server/data/agent-database.ts";
import { createPostgresSandboxDeletionStore } from "../server/data/sandbox-deletion-store.ts";

assertDockerAvailable();

const suffix = randomUUID().replaceAll("-", "");
const connectionString = process.env.AGENT_DATABASE_URL?.trim();
if (!connectionString) throw new Error("AGENT_DATABASE_URL is required for sandbox reaper verification.");
const schema = `open_agent_reaper_${suffix}`;
const database = new pg.Pool({ application_name: "open-agent-reaper-eval", connectionString, max: 1 });
await migrate(schema, database);
const deletionStore = createPostgresSandboxDeletionStore({ connectionString, maxPoolSize: 1, schema });
const owner = {
  principalId: `reaper-principal-${suffix}`,
  principalType: "user",
  tenantId: `reaper-tenant-${suffix}`,
};
const image = existingSandboxImage();
const eligible = createContainer(`eve-sbx-ses-docker-reaper-eligible-${suffix}`, `reaper-eligible-${suffix}`);
const protectedContainer = createContainer(`eve-sbx-ses-docker-reaper-protected-${suffix}`, `reaper-protected-${suffix}`);
const wrongRole = createContainer(`eve-sbx-ses-docker-reaper-template-${suffix}`, `reaper-template-${suffix}`, "template");
const running = createContainer(`eve-sbx-ses-docker-reaper-running-${suffix}`, `reaper-running-${suffix}`, "session", true);
const unauthorized = createContainer(`eve-sbx-ses-docker-reaper-unauthorized-${suffix}`, `reaper-unauthorized-${suffix}`);
const missingSessionId = `reaper-missing-${suffix}`;
const claimedMissingSessionId = `reaper-claimed-missing-${suffix}`;
const created = [eligible, protectedContainer, wrongRole, running, unauthorized];

try {
  for (const container of created) await claimOwnership(container.sessionId);
  await claimOwnership(missingSessionId);
  await claimOwnership(claimedMissingSessionId);
  for (const container of [eligible, protectedContainer, wrongRole, running]) {
    const requested = await deletionStore.request({
      owner,
      reason: "sandbox-reaper-verification",
      requestedBy: "verification",
      sessionId: container.sessionId,
    });
    assert.equal(requested.status, "created");
  }

  const missingRequest = await deletionStore.request({
    owner,
    reason: "sandbox-reaper-missing-verification",
    requestedBy: "verification",
    sessionId: missingSessionId,
  });
  assert.equal(missingRequest.status, "created");
  const missingCompletion = await deletionStore.completeMissing(missingSessionId);
  assert.equal(missingCompletion?.status, "completed");
  assert.equal(missingCompletion?.containerId, undefined);
  assert.equal(missingCompletion?.containerName, undefined);
  assert.equal(await deletionStore.completeMissing(missingSessionId), undefined);

  const claimedMissingRequest = await deletionStore.request({
    owner,
    reason: "sandbox-reaper-claimed-missing-verification",
    requestedBy: "verification",
    sessionId: claimedMissingSessionId,
  });
  assert.equal(claimedMissingRequest.status, "created");
  const activeClaim = await deletionStore.claim({
    containerId: "already-gone-container",
    containerName: "already-gone-container",
    sessionId: claimedMissingSessionId,
  });
  assert.ok(activeClaim?.claimToken);
  assert.equal(await deletionStore.completeMissing(claimedMissingSessionId), undefined);
  await deletionStore.fail(claimedMissingSessionId, activeClaim.claimToken, "fixture claim released");
  const recoveredMissingCompletion = await deletionStore.completeMissing(claimedMissingSessionId);
  assert.equal(recoveredMissingCompletion?.status, "completed");
  assert.equal(recoveredMissingCompletion?.containerId, undefined);
  assert.equal(recoveredMissingCompletion?.containerName, undefined);

  const dryRun = runReaper([
    "--session-id", eligible.sessionId,
    "--retention-hours", "0",
    "--max-removals", "10",
  ], protectedContainer.sessionId);
  assert.equal(dryRun.apply, false);
  assert.deepEqual(dryRun.candidates.map((item) => item.sessionId), [eligible.sessionId]);
  assert.equal(containerExists(eligible.id), true, "dry-run removed a container");

  const applied = runReaper([
    "--apply",
    "--session-id", eligible.sessionId,
    "--retention-hours", "0",
    "--max-removals", "10",
  ], protectedContainer.sessionId);
  assert.deepEqual(applied.removed, [eligible.id]);
  assert.equal(containerExists(eligible.id), false);
  assert.equal(containerExists(protectedContainer.id), true);
  assert.equal(containerExists(wrongRole.id), true);
  assert.equal(containerExists(running.id), true);

  const unauthorizedApplied = runReaper([
    "--apply",
    "--session-id", unauthorized.sessionId,
    "--retention-hours", "0",
    "--max-removals", "1",
  ], protectedContainer.sessionId);
  assert.deepEqual(unauthorizedApplied.removed, []);
  assert.deepEqual(unauthorizedApplied.unauthorized, [unauthorized.sessionId]);
  assert.equal(containerExists(unauthorized.id), true);

  const protectedDryRun = runReaper([
    "--session-id", protectedContainer.sessionId,
    "--retention-hours", "0",
    "--max-removals", "1",
  ], protectedContainer.sessionId);
  assert.deepEqual(protectedDryRun.candidates, []);

  const wrongRoleDryRun = runReaper([
    "--session-id", wrongRole.sessionId,
    "--retention-hours", "0",
    "--max-removals", "1",
  ], protectedContainer.sessionId);
  assert.deepEqual(wrongRoleDryRun.candidates, []);

  const runningApplied = runReaper([
    "--apply",
    "--include-running",
    "--session-id", running.sessionId,
    "--retention-hours", "0",
    "--max-removals", "1",
  ], protectedContainer.sessionId);
  assert.deepEqual(runningApplied.removed, [running.id]);
  assert.equal(containerExists(running.id), false);

  const completed = await database.query(
    `select session_id, status from "${schema}"."agent_sandbox_deletions"
      where session_id in ($1, $2) order by session_id`,
    [eligible.sessionId, running.sessionId],
  );
  assert.deepEqual(completed.rows, [
    { session_id: eligible.sessionId, status: "completed" },
    { session_id: running.sessionId, status: "completed" },
  ].sort((left, right) => left.session_id.localeCompare(right.session_id)));

  console.log(JSON.stringify({
    authorizationLedger: "completed",
    activeMissingClaim: "preserved",
    dryRun: "preserved",
    exactRunningSession: "removed",
    ownershipBoundary: "enforced",
    missingContainer: "completed-idempotently",
    protectedSession: "preserved",
    stoppedExpiredSession: "removed",
    unauthorizedSession: "preserved",
  }));
} finally {
  for (const container of created) removeContainer(container.id);
  await closeAgentDatabasePools();
  await database.query(`drop schema if exists "${schema}" cascade`);
  await database.end();
}

function createContainer(name, sessionId, role = "session", running = false) {
  const id = execFileSync("docker", [
    "create",
    "--name", name,
    "--label", "eve.sandbox=1",
    "--label", `eve.sandbox.role=${role}`,
    "--label", `eve.sandbox.tag.sessionId=${sessionId}`,
    image,
    "/bin/sh", "-c", "sleep 2147483647",
  ], { encoding: "utf8" }).trim();
  if (running) execFileSync("docker", ["start", id], { stdio: "ignore" });
  return { id, sessionId };
}

function runReaper(args, protectedSessionId) {
  const output = execFileSync(process.execPath, ["scripts/reap-docker-sandboxes.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_DATABASE_SCHEMA: schema,
      EVE_SANDBOX_PROTECTED_SESSION_IDS: protectedSessionId,
    },
  });
  return JSON.parse(output);
}

async function claimOwnership(sessionId) {
  await database.query(
    `insert into "${schema}"."agent_session_owners"
      (session_id, tenant_id, principal_id, principal_type)
     values ($1, $2, $3, $4)`,
    [sessionId, owner.tenantId, owner.principalId, owner.principalType],
  );
}

async function migrate(targetSchema, pool) {
  const source = await readFile(new URL("../server/data/migrations/0001_agent_service.sql", import.meta.url), "utf8");
  await pool.query(source.replaceAll("__AGENT_SCHEMA__", targetSchema));
}

function existingSandboxImage() {
  // Prefer the exact deployment image so the reaper gate exercises the same
  // runtime that production will create. The dedicated test override remains
  // useful for CI fixtures and local image names.
  const configured = process.env.EVE_DOCKER_REAPER_TEST_IMAGE?.trim()
    || process.env.AGENT_SANDBOX_IMAGE?.trim();
  if (configured) return configured;
  const image = execFileSync("docker", [
    "images", "ghcr.io/vercel/eve:latest", "--format", "{{.Repository}}:{{.Tag}}",
  ], { encoding: "utf8" }).trim().split("\n")[0];
  if (!image) {
    throw new Error("The local ghcr.io/vercel/eve:latest image is required; no image is pulled by this verification.");
  }
  return image;
}

function containerExists(id) {
  try {
    execFileSync("docker", ["inspect", id], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function removeContainer(id) {
  try {
    execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
  } catch {
    // The verification deliberately removes some fixtures before cleanup.
  }
}

function assertDockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error("Sandbox reaper verification requires a reachable Docker daemon.");
  }
}
