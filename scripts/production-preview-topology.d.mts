export const PRODUCTION_PREVIEW_PORTS: Readonly<{
  readonly eve: 4275;
  readonly next: 3101;
  readonly web: 3100;
}>;

export const PRODUCTION_PREVIEW_DEFAULT_ACTIVE_RUNS: 12;

export function configureEveNextProductionPort(
  environment?: Record<string, string | undefined>,
): number;

export function assertBuiltEveProxy(
  routesManifest: unknown,
  expectedPort: number,
): void;

export function assertBuiltEveWorkflowWorld(
  compiledAgentManifest: unknown,
  expectedWorld?: string,
): void;

export function productionPreviewExitCode(
  outcome: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>,
  shutdownRequested: boolean,
): number;
