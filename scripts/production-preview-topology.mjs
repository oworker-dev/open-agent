export const PRODUCTION_PREVIEW_PORTS = Object.freeze({
  eve: 4275,
  next: 3101,
  web: 3100,
});

export function configureEveNextProductionPort(environment = process.env) {
  const configured = environment.EVE_NEXT_PRODUCTION_PORT?.trim();
  const port = configured ? Number(configured) : PRODUCTION_PREVIEW_PORTS.eve;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== String(configured || port)) {
    throw new Error("EVE_NEXT_PRODUCTION_PORT must be an integer between 1 and 65535.");
  }
  environment.EVE_NEXT_PRODUCTION_PORT = String(port);
  return port;
}

export function assertBuiltEveProxy(routesManifest, expectedPort) {
  const rewrites = routesManifest?.rewrites;
  const rules = Array.isArray(rewrites)
    ? rewrites
    : [
        ...(rewrites?.beforeFiles ?? []),
        ...(rewrites?.afterFiles ?? []),
        ...(rewrites?.fallback ?? []),
      ];
  const rule = rules.find((candidate) => candidate?.source === "/eve/v1/:path+");
  if (!rule || typeof rule.destination !== "string") {
    throw new Error("The Next.js build does not contain the Eve proxy rewrite.");
  }
  const expectedPrefix = `http://127.0.0.1:${expectedPort}/eve/v1/`;
  if (!rule.destination.startsWith(expectedPrefix)) {
    throw new Error(
      `The Next.js build proxies Eve to ${rule.destination}, but production will listen on port ${expectedPort}. Rebuild the web app before starting it.`,
    );
  }
}

export function assertBuiltEveWorkflowWorld(
  compiledAgentManifest,
  expectedWorld = "@workflow/world-postgres",
) {
  const actualWorld = compiledAgentManifest?.config?.experimental?.workflow?.world;
  if (actualWorld !== expectedWorld) {
    throw new Error(
      `The compiled Eve agent uses Workflow World ${String(actualWorld || "local")}, but production requires ${expectedWorld}. Rebuild Eve with the production Workflow World selected.`,
    );
  }
}

export function productionPreviewExitCode(outcome, shutdownRequested) {
  if (shutdownRequested) return 0;
  if (typeof outcome?.code === "number" && outcome.code !== 0) return outcome.code;
  return 1;
}
