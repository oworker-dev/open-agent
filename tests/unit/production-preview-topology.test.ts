import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBuiltEveProxy,
  assertBuiltEveWorkflowWorld,
  configureEveNextProductionPort,
  productionPreviewExitCode,
  PRODUCTION_PREVIEW_PORTS,
} from "../../scripts/production-preview-topology.mjs";

test("uses one default Eve port for the production web build and runtime", () => {
  const environment: Record<string, string | undefined> = {};
  assert.equal(configureEveNextProductionPort(environment), PRODUCTION_PREVIEW_PORTS.eve);
  assert.equal(environment.EVE_NEXT_PRODUCTION_PORT, String(PRODUCTION_PREVIEW_PORTS.eve));
});

test("rejects a Next build whose Eve proxy port differs from the runtime", () => {
  const manifest = {
    rewrites: {
      beforeFiles: [{
        destination: "http://127.0.0.1:4274/eve/v1/:path+",
        source: "/eve/v1/:path+",
      }],
    },
  };
  assert.throws(
    () => assertBuiltEveProxy(manifest, PRODUCTION_PREVIEW_PORTS.eve),
    /proxies Eve to .*4274.*listen on port 4275/u,
  );
});

test("accepts a matching built Eve proxy", () => {
  const manifest = {
    rewrites: {
      beforeFiles: [{
        destination: "http://127.0.0.1:4275/eve/v1/:path+",
        source: "/eve/v1/:path+",
      }],
    },
  };
  assert.doesNotThrow(() => assertBuiltEveProxy(manifest, PRODUCTION_PREVIEW_PORTS.eve));
});

test("rejects an Eve artifact compiled with the local Workflow World", () => {
  assert.throws(
    () => assertBuiltEveWorkflowWorld({ config: {} }),
    /uses Workflow World local.*requires @workflow\/world-postgres/u,
  );
});

test("accepts an Eve artifact compiled with the Postgres Workflow World", () => {
  assert.doesNotThrow(() => assertBuiltEveWorkflowWorld({
    config: {
      experimental: {
        workflow: { world: "@workflow/world-postgres" },
      },
    },
  }));
});

test("treats every unexpected critical process exit as a supervisor failure", () => {
  assert.equal(productionPreviewExitCode({ code: 0, signal: null }, false), 1);
  assert.equal(productionPreviewExitCode({ code: 23, signal: null }, false), 23);
  assert.equal(productionPreviewExitCode({ code: null, signal: "SIGKILL" }, false), 1);
  assert.equal(productionPreviewExitCode({ code: null, signal: "SIGTERM" }, true), 0);
});
