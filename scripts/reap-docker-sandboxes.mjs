import { execFileSync } from "node:child_process";

import {
  EVE_DOCKER_SANDBOX_SESSION_LABEL,
  selectDockerSandboxRetentionCandidates,
} from "../lib/docker-sandbox-retention.ts";
import { closeAgentDatabasePools } from "../server/data/agent-database.ts";
import { createPostgresSandboxDeletionStoreFromEnvironment } from "../server/data/sandbox-deletion-store.ts";

try {
  await main();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
} finally {
  await closeAgentDatabasePools();
}

async function main() {
  const options = parseOptions(process.argv.slice(2), process.env);
  if (options.help) return printHelp();

  assertDockerAvailable();
  const containers = listEveSandboxContainers();
  const selection = selectDockerSandboxRetentionCandidates(containers, {
    includeRunning: options.includeRunning,
    maxRemovals: options.maxRemovals,
    nowMs: Date.now(),
    protectedSessionIds: options.protectedSessionIds,
    retentionHours: options.retentionHours,
    sessionId: options.sessionId,
  });
  const matchingSessionContainers = options.sessionId
    ? containers
      .filter((container) => container.labels[EVE_DOCKER_SANDBOX_SESSION_LABEL] === options.sessionId)
      .map((container) => ({
        containerId: container.id,
        containerName: container.name,
        running: container.running,
      }))
    : [];

  const deletionStore = options.apply
    ? createPostgresSandboxDeletionStoreFromEnvironment()
    : undefined;
  if (options.apply && !deletionStore) {
    throw new Error("AGENT_DATABASE_URL is required for --apply deletion authorization.");
  }

  const removed = [];
  const unauthorized = [];
  if (deletionStore) {
    for (const candidate of selection.candidates) {
      const claim = await deletionStore.claim({
        containerId: candidate.container.id,
        containerName: candidate.container.name,
        sessionId: candidate.sessionId,
      });
      if (!claim?.claimToken) {
        unauthorized.push(candidate.sessionId);
        continue;
      }

      try {
        const current = inspectContainer(candidate.container.id);
        const revalidated = selectDockerSandboxRetentionCandidates(current ? [current] : [], {
          includeRunning: options.includeRunning,
          maxRemovals: 1,
          nowMs: Date.now(),
          protectedSessionIds: options.protectedSessionIds,
          retentionHours: options.retentionHours,
          sessionId: candidate.sessionId,
        });
        if (revalidated.candidates.length !== 1) {
          throw new Error(
            `Refusing to remove ${candidate.container.name}: ownership or lifecycle changed after selection.`,
          );
        }

        execFileSync(
          dockerBinary(),
          ["rm", ...(options.includeRunning ? ["-f"] : []), candidate.container.id],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        await deletionStore.complete(candidate.sessionId, claim.claimToken);
        removed.push(candidate.container.id);
      } catch (cause) {
        await deletionStore.fail(
          candidate.sessionId,
          claim.claimToken,
          cause instanceof Error ? cause.message : String(cause),
        ).catch(() => undefined);
        throw cause;
      }
    }
  }

  const skippedByReason = {};
  for (const item of selection.skipped) {
    skippedByReason[item.reason] = (skippedByReason[item.reason] ?? 0) + 1;
  }

  console.log(JSON.stringify({
    apply: options.apply,
    authorizationRequired: true,
    candidates: selection.candidates.map((candidate) => ({
      containerId: candidate.container.id,
      containerName: candidate.container.name,
      idleHours: Number(candidate.idleHours.toFixed(2)),
      lastLifecycleAt: candidate.lastLifecycleAt,
      sessionId: candidate.sessionId,
    })),
    inspected: containers.length,
    maxRemovals: options.maxRemovals,
    matchingSessionContainers,
    removed,
    retentionHours: options.retentionHours,
    skippedByReason,
    unauthorized,
  }));
}

function parseOptions(args, environment) {
  let apply = false;
  let help = false;
  let includeRunning = false;
  let maxRemovals = environment.EVE_SANDBOX_REAPER_MAX_REMOVALS;
  let retentionHours = environment.EVE_SANDBOX_RETENTION_HOURS;
  let sessionId;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--include-running") includeRunning = true;
    else if (argument === "--max-removals") maxRemovals = requireArgument(args, ++index, argument);
    else if (argument === "--retention-hours") retentionHours = requireArgument(args, ++index, argument);
    else if (argument === "--session-id") sessionId = requireArgument(args, ++index, argument);
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }

  if (help) return { help: true };
  const parsedRetentionHours = parseNumber(retentionHours, "EVE_SANDBOX_RETENTION_HOURS", 0, 87_600);
  const parsedMaxRemovals = parseInteger(maxRemovals, "EVE_SANDBOX_REAPER_MAX_REMOVALS", 1, 10_000);
  if (sessionId && (sessionId.length > 512 || /\s/.test(sessionId))) {
    throw new Error("--session-id must be a non-empty identifier without whitespace (maximum 512 characters).");
  }
  if (includeRunning && !sessionId) {
    throw new Error("--include-running requires --session-id with the exact durable session id.");
  }

  return {
    apply,
    help: false,
    includeRunning,
    maxRemovals: parsedMaxRemovals,
    protectedSessionIds: new Set(
      (environment.EVE_SANDBOX_PROTECTED_SESSION_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    retentionHours: parsedRetentionHours,
    sessionId,
  };
}

function listEveSandboxContainers() {
  const ids = execFileSync(
    dockerBinary(),
    ["ps", "-a", "--filter", "label=eve.sandbox=1", "--format", "{{.ID}}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim().split("\n").filter(Boolean);
  if (ids.length === 0) return [];
  return inspectContainers(ids);
}

function inspectContainer(id) {
  try {
    return inspectContainers([id])[0];
  } catch {
    return undefined;
  }
}

function inspectContainers(ids) {
  const inspected = JSON.parse(execFileSync(dockerBinary(), ["inspect", ...ids], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  if (!Array.isArray(inspected)) throw new Error("Docker inspect returned an invalid response.");
  return inspected.map((container) => ({
    createdAt: String(container.Created ?? ""),
    finishedAt: String(container.State?.FinishedAt ?? ""),
    id: String(container.Id ?? ""),
    labels: normalizeLabels(container.Config?.Labels),
    name: String(container.Name ?? "").replace(/^\//, ""),
    running: container.State?.Running === true,
    startedAt: String(container.State?.StartedAt ?? ""),
  }));
}

function normalizeLabels(labels) {
  if (!labels || typeof labels !== "object") return {};
  return Object.fromEntries(
    Object.entries(labels).filter((entry) => typeof entry[1] === "string"),
  );
}

function assertDockerAvailable() {
  try {
    execFileSync(dockerBinary(), ["info"], { stdio: "ignore" });
  } catch {
    throw new Error(`A reachable Docker daemon is required through ${dockerBinary()}.`);
  }
}

function dockerBinary() {
  return process.env.EVE_DOCKER_PATH?.trim() || "docker";
}

function requireArgument(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function parseNumber(value, name, minimum, maximum) {
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseInteger(value, name, minimum, maximum) {
  const parsed = parseNumber(value, name, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

function printHelp() {
  console.log(`Usage: npm run reap:sandboxes -- [options]

Dry-run is the default. Set EVE_SANDBOX_RETENTION_HOURS and
EVE_SANDBOX_REAPER_MAX_REMOVALS or pass their command-line equivalents.

Options:
  --apply                  Remove only database-authorized containers
  --retention-hours N      Minimum idle age in hours
  --max-removals N         Maximum containers selected in one invocation
  --session-id ID          Restrict selection to one durable session
  --include-running        Permit removal of that exact running session
  -h, --help               Show this help

EVE_SANDBOX_PROTECTED_SESSION_IDS is a comma-separated denylist. Applying a
deletion also requires AGENT_DATABASE_URL and an authorized sandbox deletion
record created after the durable session was terminally retired.`);
}
