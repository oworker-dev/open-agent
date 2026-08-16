import { closeAgentDatabasePools } from "../server/data/agent-database.ts";
import { createAssetStoreFromEnvironment } from "../server/data/asset-store.ts";

try {
  const limit = parseLimit(process.env.AGENT_ASSET_CLEANUP_LIMIT);
  const store = createAssetStoreFromEnvironment();
  if (!store.cleanupExpired) {
    throw new Error("The configured AssetStore does not provide cleanupExpired().");
  }
  const result = await store.cleanupExpired({ limit });
  console.log(JSON.stringify({ limit, ...result }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await closeAgentDatabasePools();
}

function parseLimit(value) {
  if (!value?.trim()) return 100;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("AGENT_ASSET_CLEANUP_LIMIT must be an integer from 1 to 10000.");
  }
  return limit;
}
