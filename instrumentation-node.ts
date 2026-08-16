import { configureAssetScanner } from "./server/data/asset-store.ts";
import { createClamAvAssetScannerFromEnvironment } from "./server/data/clamav-asset-scanner.ts";

export function registerNodeRuntime(): void {
  const scanner = createClamAvAssetScannerFromEnvironment();
  if (scanner) configureAssetScanner(scanner);
}
