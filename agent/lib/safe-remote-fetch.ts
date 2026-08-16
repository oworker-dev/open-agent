import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent as UndiciAgent } from "undici";

export const MAX_REMOTE_REDIRECTS = 5;
const DEFAULT_FETCH = globalThis.fetch;

export type SafeRemoteFetchOptions = {
  readonly fetchImplementation?: typeof fetch;
  readonly headers?: HeadersInit;
  readonly maxRedirects?: number;
  /** Host/test override for DNS resolution. Production defaults to node DNS. */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly signal?: AbortSignal;
};

export type SafeRemoteResponse = {
  readonly response: Response;
  readonly url: string;
};

/**
 * Validate every URL before it is requested. This is deliberately host
 * neutral: deployments can replace the resolver/fetcher at the boundary, but
 * the default adapter still rejects the address classes that are unsafe for a
 * server-side fetch (including cloud metadata and DNS-resolved private IPs).
 */
export async function safeRemoteFetch(
  input: string,
  options: SafeRemoteFetchOptions = {},
): Promise<SafeRemoteResponse> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? MAX_REMOTE_REDIRECTS, 0), 10);
  // A host/test replacement is already responsible for its own transport;
  // the built-in fetch path remains fail-closed on DNS failure.
  const allowUnresolved = options.fetchImplementation !== undefined || fetchImplementation !== DEFAULT_FETCH;
  let target = await resolveRemoteTarget(input, options.resolveAddresses ?? resolvePublicAddresses, allowUnresolved);
  let current = target.url;
  for (let redirect = 0; ; redirect += 1) {
    const response = await fetchImplementation(current.toString(), {
      redirect: "manual",
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(fetchImplementation === DEFAULT_FETCH && target.addresses.length > 0
        ? { dispatcher: pinnedDispatcher(current.hostname, target.addresses) }
        : {}),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: current.toString() };
    }
    if (redirect >= maxRedirects) throw new Error("The remote resource exceeded the redirect limit.");
    const location = response.headers.get("location");
    if (!location) throw new Error("The remote resource returned a redirect without a location.");
    target = await resolveRemoteTarget(new URL(location, current).toString(), options.resolveAddresses ?? resolvePublicAddresses, allowUnresolved);
    current = target.url;
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function readRemoteBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`The remote response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error(`The remote response exceeds the ${maxBytes}-byte limit.`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function validateRemoteUrl(value: string): Promise<URL> {
  return (await resolveRemoteTarget(value, resolvePublicAddresses, false)).url;
}

async function resolveRemoteTarget(
  value: string,
  resolver: (hostname: string) => Promise<readonly string[]>,
  allowUnresolved: boolean,
): Promise<{ readonly addresses: readonly string[]; readonly url: URL }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL must be absolute and use http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http:// or https://.");
  }
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("Only ports 80 and 443 are allowed for remote resources.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!hostname || isBlockedHostname(hostname)) throw new Error("The remote host is not publicly routable.");
  const addresses = await resolver(hostname);
  if (addresses.length === 0 && !allowUnresolved) throw new Error("The remote host could not be resolved.");
  if (addresses.some(isBlockedAddress)) throw new Error("The remote host resolves to a private or link-local address.");
  return { addresses, url };
}

const pinnedDispatchers = new Map<string, UndiciAgent>();

function pinnedDispatcher(hostname: string, addresses: readonly string[]): UndiciAgent {
  const key = `${hostname.toLowerCase()}|${addresses.join(",")}`;
  const existing = pinnedDispatchers.get(key);
  if (existing) return existing;
  const dispatcher = new UndiciAgent({
    connect: {
      lookup: createPinnedLookup(addresses),
    },
  });
  pinnedDispatchers.set(key, dispatcher);
  // Bound the dispatcher cache. Existing requests retain their connection;
  // evicted idle agents are closed asynchronously to avoid unbounded memory.
  if (pinnedDispatchers.size > 256) {
    const oldest = pinnedDispatchers.entries().next().value as [string, UndiciAgent] | undefined;
    if (oldest) {
      pinnedDispatchers.delete(oldest[0]);
      void oldest[1].close().catch(() => undefined);
    }
  }
  return dispatcher;
}

/** Build the Node lookup contract without allowing a second DNS resolution. */
export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  return (_host, options, callback) => {
    const requestedFamily = typeof options.family === "number"
      ? options.family
      : options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : 0;
    const matching = addresses.filter((address) =>
      requestedFamily === 0 || isIP(address) === requestedFamily
    );
    if (matching.length === 0) {
      const error = Object.assign(new Error("The pinned remote host has no address in the requested family."), {
        code: "ENOTFOUND",
      });
      callback(error, options.all ? [] : "", requestedFamily || undefined);
      return;
    }
    if (options.all) {
      callback(null, matching.map((address) => ({ address, family: isIP(address) })));
      return;
    }
    const address = matching[0]!;
    callback(null, address, isIP(address));
  };
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  try {
    return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch (error) {
    // An unresolved test or temporarily unavailable public name will fail at
    // fetch time. Do not turn DNS outage into a private-address allow-list;
    // known blocked names are rejected before this fallback.
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOTFOUND") return [];
    throw new Error("The remote host could not be resolved.");
  }
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal" || hostname.endsWith(".internal") ||
    hostname === "0.0.0.0" || hostname === "::" || hostname === "[::1]";
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  try {
    // `process` normalizes IPv4-mapped IPv6 addresses before classification.
    // Admit public unicast only; private, loopback, link-local, multicast,
    // documentation, benchmarking, transition, and reserved ranges all fail
    // closed without maintaining a second hand-written CIDR table here.
    return ipaddr.process(normalized).range() !== "unicast";
  } catch {
    return true;
  }
}
