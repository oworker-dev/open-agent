import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";

import {
  createClamAvAssetScanner,
  createClamAvAssetScannerFromEnvironment,
} from "../../server/data/clamav-asset-scanner.ts";

test("ClamAV scanner streams INSTREAM frames and accepts a clean result", async () => {
  const fixture = await startClamdFixture("stream: OK\0");
  try {
    const scanner = createClamAvAssetScanner({ host: "127.0.0.1", port: fixture.port, timeoutMs: 2_000 });
    const result = await scanner.scan({
      asset: fixtureAsset,
      openReadStream: async () => streamOf(Buffer.from("first"), Buffer.from("second")),
    });
    assert.deepEqual(result, { status: "clean" });
    assert.equal((await fixture.received).toString("utf8"), "firstsecond");
  } finally {
    await fixture.close();
  }
});

test("ClamAV scanner rejects malware without exposing the signature", async () => {
  const fixture = await startClamdFixture("stream: Eicar-Test-Signature FOUND\0");
  try {
    const scanner = createClamAvAssetScanner({ host: "127.0.0.1", port: fixture.port, timeoutMs: 2_000 });
    assert.deepEqual(await scanner.scan({ asset: fixtureAsset, openReadStream: async () => streamOf(Buffer.from("probe")) }), {
      reason: "malware-detected",
      status: "rejected",
    });
  } finally {
    await fixture.close();
  }
});

test("ClamAV scanner fails closed for scanner errors and invalid configuration", async () => {
  const fixture = await startClamdFixture("stream: size limit exceeded ERROR\0");
  try {
    const scanner = createClamAvAssetScanner({ host: "127.0.0.1", port: fixture.port, timeoutMs: 2_000 });
    await assert.rejects(
      scanner.scan({ asset: fixtureAsset, openReadStream: async () => streamOf(Buffer.from("probe")) }),
      /invalid or failed result/u,
    );
  } finally {
    await fixture.close();
  }
  assert.equal(createClamAvAssetScannerFromEnvironment({}), undefined);
  assert.throws(
    () => createClamAvAssetScannerFromEnvironment({ AGENT_ASSET_CLAMAV_HOST: "clamd", AGENT_ASSET_CLAMAV_PORT: "70000" }),
    /AGENT_ASSET_CLAMAV_PORT/u,
  );
});

const fixtureAsset = {
  assetId: "asset_fixture",
  createdAt: new Date(0).toISOString(),
  filename: "fixture.bin",
  mediaType: "application/octet-stream",
  principalId: "principal_fixture",
  scanStatus: "scanning" as const,
  sessionId: "session_fixture",
  sizeBytes: 11,
  status: "ready" as const,
  storageKey: "assets/fixture",
  tenantId: "tenant_fixture",
};

function streamOf(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function startClamdFixture(response: string): Promise<{
  readonly close: () => Promise<void>;
  readonly port: number;
  readonly received: Promise<Buffer>;
}> {
  let resolveReceived!: (value: Buffer) => void;
  const received = new Promise<Buffer>((resolve) => { resolveReceived = resolve; });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const frames: Buffer[] = [];
    let input = Buffer.alloc(0);
    let headerRead = false;
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (!headerRead) {
        const terminator = input.indexOf(0);
        if (terminator < 0) return;
        assert.equal(input.subarray(0, terminator).toString("ascii"), "zINSTREAM");
        input = input.subarray(terminator + 1);
        headerRead = true;
      }
      while (input.byteLength >= 4) {
        const size = input.readUInt32BE(0);
        if (size === 0) {
          input = input.subarray(4);
          resolveReceived(Buffer.concat(frames));
          socket.end(response);
          return;
        }
        if (input.byteLength < size + 4) return;
        frames.push(input.subarray(4, size + 4));
        input = input.subarray(size + 4);
      }
    });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address.");
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    port: address.port,
    received,
  };
}
