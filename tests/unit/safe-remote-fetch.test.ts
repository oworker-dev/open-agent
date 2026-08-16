import assert from "node:assert/strict";
import test from "node:test";
import { createPinnedLookup, safeRemoteFetch, validateRemoteUrl } from "../../agent/lib/safe-remote-fetch.ts";

test("safe remote fetch rejects private, metadata, credentialed, and non-standard-port URLs", async () => {
  await assert.rejects(() => validateRemoteUrl("http://127.0.0.1/image"), /publicly routable|private/);
  await assert.rejects(() => validateRemoteUrl("http://169.254.169.254/latest/meta-data"), /publicly routable|private/);
  await assert.rejects(() => validateRemoteUrl("http://metadata.google.internal/"), /publicly routable/);
  await assert.rejects(() => validateRemoteUrl("https://user:pass@example.com/"), /credentials/);
  await assert.rejects(() => validateRemoteUrl("https://example.com:8443/"), /ports/);
});

test("safe remote fetch rejects every non-public IP class", async () => {
  const blocked = [
    "http://224.0.0.1/", // IPv4 multicast
    "http://192.0.2.1/", // documentation/reserved
    "http://198.51.100.1/", // documentation/reserved
    "http://203.0.113.1/", // documentation/reserved
    "http://[fe90::1]/", // IPv6 link-local outside the old fe80 prefix check
    "http://[feb0::1]/", // upper edge of fe80::/10
    "http://[ff02::1]/", // IPv6 multicast
    "http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
  ];
  for (const url of blocked) {
    await assert.rejects(() => validateRemoteUrl(url), /publicly routable|private/, url);
  }
});

test("safe remote fetch validates every redirect hop", async () => {
  const requests: string[] = [];
  const response = await safeRemoteFetch("https://assets.example/start", {
    fetchImplementation: async (input) => {
      requests.push(String(input));
      if (requests.length === 1) return new Response(null, { headers: { location: "https://assets.example/final" }, status: 302 });
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(response.url, "https://assets.example/final");
  assert.deepEqual(requests, ["https://assets.example/start", "https://assets.example/final"]);
});

test("pinned DNS lookup satisfies Node single-address and all-address contracts", async () => {
  const lookup = createPinnedLookup(["203.0.113.10", "2001:db8::10"]);
  const all = await new Promise<unknown>((resolve, reject) => {
    lookup("example.test", { all: true, family: 0 }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(all, [
    { address: "203.0.113.10", family: 4 },
    { address: "2001:db8::10", family: 6 },
  ]);

  const ipv4 = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
    lookup("example.test", { all: false, family: 4 }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(ipv4, { address: "203.0.113.10", family: 4 });
});
