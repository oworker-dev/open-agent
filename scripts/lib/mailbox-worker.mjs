export async function dispatchMailboxTick(endpoint, secret, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint, {
    headers: { authorization: `Bearer ${secret}` },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  try {
    if (!response.ok) {
      throw new Error(`Mailbox dispatcher returned HTTP ${response.status}.`);
    }
  } finally {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Body cleanup must not replace the dispatch result or error.
      }
    }
  }
}
