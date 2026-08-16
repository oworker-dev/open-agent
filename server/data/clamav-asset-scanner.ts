import type { AssetScanner } from "@oworker/open-agent-contracts/asset";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

export type ClamAvAssetScannerOptions = {
  readonly host: string;
  readonly port?: number;
  readonly timeoutMs?: number;
};

/**
 * Constant-memory clamd INSTREAM adapter for standalone production installs.
 * Hosts may continue to inject any other AssetScanner implementation.
 */
export function createClamAvAssetScanner(options: ClamAvAssetScannerOptions): AssetScanner {
  const host = requiredHost(options.host);
  const port = boundedInteger(options.port ?? DEFAULT_PORT, "ClamAV port", 1, 65_535);
  const timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "ClamAV timeout", 1_000, 600_000);
  return {
    async scan({ openReadStream }) {
      const response = await scanClamdStream(await openReadStream(), { host, port, timeoutMs });
      if (response.endsWith(" OK")) return { status: "clean" };
      if (response.endsWith(" FOUND")) return { status: "rejected", reason: "malware-detected" };
      throw new Error("The asset scanner returned an invalid or failed result.");
    },
  };
}

export function createClamAvAssetScannerFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AssetScanner | undefined {
  const host = environment.AGENT_ASSET_CLAMAV_HOST?.trim();
  if (!host) return undefined;
  return createClamAvAssetScanner({
    host,
    port: optionalInteger(environment.AGENT_ASSET_CLAMAV_PORT, "AGENT_ASSET_CLAMAV_PORT", 1, 65_535) ?? DEFAULT_PORT,
    timeoutMs: optionalInteger(environment.AGENT_ASSET_CLAMAV_TIMEOUT_MS, "AGENT_ASSET_CLAMAV_TIMEOUT_MS", 1_000, 600_000) ?? DEFAULT_TIMEOUT_MS,
  });
}

async function scanClamdStream(
  stream: ReadableStream<Uint8Array>,
  options: Required<ClamAvAssetScannerOptions>,
): Promise<string> {
  const socket = createConnection({ host: options.host, port: options.port });
  socket.setNoDelay(true);
  socket.setTimeout(options.timeoutMs);
  const response = readResponse(socket);
  try {
    await once(socket, "connect");
    await writeSocket(socket, Buffer.from("zINSTREAM\0", "ascii"));
    const reader = stream.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.byteLength === 0) continue;
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(next.value.byteLength, 0);
        await writeSocket(socket, header);
        await writeSocket(socket, Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
      }
    } finally {
      reader.releaseLock();
    }
    await writeSocket(socket, Buffer.alloc(4));
    return await response;
  } finally {
    socket.destroy();
  }
}

function readResponse(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const finish = () => {
      cleanup();
      const raw = Buffer.concat(chunks, total);
      const terminator = raw.indexOf(0);
      const response = raw.subarray(0, terminator >= 0 ? terminator : raw.byteLength).toString("utf8").trim();
      if (!response) return reject(new Error("The asset scanner returned an empty response."));
      resolve(response);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) return fail(new Error("The asset scanner response exceeded its limit."));
      chunks.push(chunk);
      if (chunk.includes(0)) finish();
    };
    const onEnd = () => finish();
    const onError = () => fail(new Error("The asset scanner connection failed."));
    const onTimeout = () => fail(new Error("The asset scanner timed out."));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

async function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (socket.destroyed) throw new Error("The asset scanner connection closed before upload completed.");
  if (!socket.write(bytes)) await once(socket, "drain");
}

function requiredHost(value: string): string {
  const host = value.trim();
  if (!host || host.length > 253 || /[\u0000-\u001f\u007f/]/u.test(host)) {
    throw new Error("ClamAV host must be a valid hostname or IP address.");
  }
  return host;
}

function optionalInteger(value: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (!value?.trim()) return undefined;
  return boundedInteger(Number(value), name, minimum, maximum);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
