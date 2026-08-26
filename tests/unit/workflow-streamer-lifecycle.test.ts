// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

// world-postgres keeps its own pg dependency. Patch only that test-local
// client so createStreamer can be exercised without a PostgreSQL server.
import nestedPg from "../../node_modules/@workflow/world-postgres/node_modules/pg/lib/index.js";

const { Client } = nestedPg;
const originalClientMethods = {
  connect: Client.prototype.connect,
  end: Client.prototype.end,
  query: Client.prototype.query,
};
Client.prototype.connect = async function connect() {};
Client.prototype.end = async function end() {};
Client.prototype.query = async function query() { return { rows: [] }; };

const { createStreamer } = await import(
  "../../node_modules/@workflow/world-postgres/dist/streamer.js"
);

test.after(() => {
  Client.prototype.connect = originalClientMethods.connect;
  Client.prototype.end = originalClientMethods.end;
  Client.prototype.query = originalClientMethods.query;
});

test("closes and cleans up when startIndex skips an existing EOF row", async () => {
  const drizzle = fakeDrizzle([
    chunk("chnk_0001", "one"),
    chunk("chnk_0002", "two"),
    chunk("chnk_0003", "", true),
  ]);
  const streamer = createStreamer(fakePool(), drizzle);
  try {
    const stream = await streamer.streams.get("run", "stream", 99);
    const reader = stream.getReader();
    assert.deepEqual(await reader.read(), { value: undefined, done: true });
    assert.equal(drizzle.dataQueries, 1);
    assert.equal(drizzle.eofQueries, 1);
  } finally {
    await streamer.close();
  }
});

test("stops historical pagination after a reader is cancelled", async () => {
  const releaseFirstPage = deferred();
  const drizzle = fakeDrizzle(
    [chunk("chnk_0001", "one")],
    { firstDataPage: releaseFirstPage.promise },
  );
  const streamer = createStreamer(fakePool(), drizzle);
  try {
    const stream = await streamer.streams.get("run", "stream", 0);
    const reader = stream.getReader();
    await waitFor(() => drizzle.dataQueries === 1);

    const cancelled = reader.cancel();
    releaseFirstPage.resolve();
    await cancelled;
    await Promise.resolve();

    assert.equal(drizzle.dataQueries, 1);
  } finally {
    await streamer.close();
  }
});

test("keeps a live stream open when history has no EOF", async () => {
  const drizzle = fakeDrizzle([chunk("chnk_0001", "one")]);
  const streamer = createStreamer(fakePool(), drizzle);
  try {
    const stream = await streamer.streams.get("run", "stream", 0);
    const reader = stream.getReader();
    const first = await reader.read();
    assert.deepEqual(first.value, new Uint8Array(Buffer.from("one")));
    assert.equal(first.done, false);
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(drizzle.eofQueries, 0);
    await reader.cancel();
    await pending.catch(() => undefined);
  } finally {
    await streamer.close();
  }
});

function fakePool() {
  return {
    options: {},
    query: async () => ({ rows: [] }),
  };
}

function fakeDrizzle(rows, options = {}) {
  const state = {
    dataQueries: 0,
    eofQueries: 0,
    countQueries: 0,
  };
  const drizzle = {
    ...state,
    select(selection) {
      const keys = Object.keys(selection);
      const kind = keys.includes("count")
        ? "count"
        : keys.includes("id")
          ? "data"
          : "eof";
      const query = {
        offsetValue: 0,
        limitValue: rows.length,
        from() { return query; },
        where() { return query; },
        orderBy() { return query; },
        offset(value) { query.offsetValue = value; return query; },
        limit(value) { query.limitValue = value; return query; },
        then(resolve, reject) {
          Promise.resolve().then(async () => {
            if (kind === "count") {
              drizzle.countQueries += 1;
              return [{ count: String(rows.filter((row) => !row.eof).length) }];
            }
            if (kind === "eof") {
              drizzle.eofQueries += 1;
              return rows.some((row) => row.eof) ? [{ eof: true }] : [];
            }
            drizzle.dataQueries += 1;
            if (drizzle.dataQueries === 1 && options.firstDataPage) {
              await options.firstDataPage;
            }
            return rows.slice(query.offsetValue, query.offsetValue + query.limitValue);
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return drizzle;
}

function chunk(id, value, eof = false) {
  return { id, eof, data: Buffer.from(value) };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fake query.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
