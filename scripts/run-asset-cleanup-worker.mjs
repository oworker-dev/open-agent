import { closeAgentDatabasePools } from "../server/data/agent-database.ts";
import { createAssetStoreFromEnvironment } from "../server/data/asset-store.ts";

const intervalMs = parseInteger(process.env.AGENT_ASSET_CLEANUP_INTERVAL_MS, 3_600_000);
const limit = parseInteger(process.env.AGENT_ASSET_CLEANUP_LIMIT, 100);
const store = createAssetStoreFromEnvironment();
if (!store.cleanupExpired) throw new Error("The configured AssetStore does not provide cleanupExpired().");

let stopped = false;
let running = false;
let wake;
const stop = () => { stopped = true; };
const requestStop = () => {
  stop();
  wake?.();
};
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

try {
  while (!stopped) {
    if (!running) {
      running = true;
      try {
        const result = await store.cleanupExpired({ limit });
        if (result.deletedAssets > 0 || result.abortedUploads > 0) {
          console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
        }
      } catch (error) {
        console.error("Asset cleanup failed", error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    }
    if (stopped) break;
    await interruptibleDelay(intervalMs);
  }
} finally {
  await closeAgentDatabasePools();
}

function parseInteger(value, fallback) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400_000) {
    throw new Error("Asset cleanup configuration must be a positive bounded integer.");
  }
  return parsed;
}

function interruptibleDelay(milliseconds) {
  if (stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = undefined;
      resolve();
    }, milliseconds);
    wake = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
  });
}
