import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBroker, cronMatches, encodeFrame, listen, type Broker, type FetchLike } from "./broker";
import { walkAssets, type AssetManifest } from "./assets";
import { jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";

/** Reply frames are JSON; these narrow one field down to what an assertion reads. */
const obj = (value: JsonValue | undefined): JsonObject => jsonObject(value ?? null) ?? {};
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

const brokers: Broker[] = [];
afterEach(() => {
  for (const b of brokers) b.close();
  brokers.length = 0;
});

function make(opts: Parameters<typeof createBroker>[0] = {}): Broker {
  const b = createBroker(opts);
  brokers.push(b);
  return b;
}

test("ping round-trips", async () => {
  const b = make();
  expect(await b.dispatch({ op: "ping", msg: "hi" })).toMatchObject({ ok: true, op: "pong", echo: "hi" });
});

test("KV put / get / list / delete, scoped to a bound namespace", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toEqual({ ok: true, found: false, value: null });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k", value: "v" });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k2", value: "v2" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toEqual({ ok: true, found: true, value: "v" });
  expect(await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "k" })).toEqual({ ok: true, keys: ["k", "k2"] });
  await b.dispatch({ op: "kv.delete", ns: "CACHE", key: "k" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toMatchObject({ found: false });
});

test("an unbound KV namespace is rejected", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  await expect(b.dispatch({ op: "kv.put", ns: "OTHER", key: "k", value: "v" })).rejects.toThrow("not bound");
});

test("secrets resolve only when both bound and present", async () => {
  const b = make({ bindings: { secrets: ["API_KEY", "MISSING"] }, secrets: { API_KEY: "s3cr3t" } });
  expect(await b.dispatch({ op: "secret.get", name: "API_KEY" })).toEqual({ ok: true, value: "s3cr3t" });
  await expect(b.dispatch({ op: "secret.get", name: "MISSING" })).rejects.toThrow("no value");
  await expect(b.dispatch({ op: "secret.get", name: "UNBOUND" })).rejects.toThrow("not bound");
});

test("fetch is gated by the exact-host allowlist", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(String(url));
    return new Response("body", { status: 200, headers: { "x-mark": "1" } });
  };
  const b = make({ bindings: { outbound: ["api.example.com"] }, fetchImpl });

  await expect(b.dispatch({ op: "fetch", url: "https://evil.example.com/x" })).rejects.toThrow("allowlist");
  expect(calls).toEqual([]);

  const res = await b.dispatch({ op: "fetch", url: "https://api.example.com/x" });
  expect(res).toMatchObject({ ok: true, status: 200, body: "body" });
  expect(calls).toEqual(["https://api.example.com/x"]);
});

test("D1: query / run / batch on a bound database, isolated per name", async () => {
  const b = make({ bindings: { d1: ["DB", "OTHER"] } });
  await b.dispatch({ op: "d1.exec", db: "DB", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" });
  const ins = await b.dispatch({ op: "d1.query", db: "DB", sql: "INSERT INTO t (name) VALUES (?)", params: ["ada"] });
  expect(ins).toMatchObject({ ok: true, results: [] });
  expect(obj(ins.meta).changes).toBe(1);
  expect(obj(ins.meta).last_row_id).toBe(1);

  const sel = await b.dispatch({ op: "d1.query", db: "DB", sql: "SELECT * FROM t", params: [] });
  expect(sel.results).toEqual([{ id: 1, name: "ada" }]);

  const batch = await b.dispatch({
    op: "d1.batch",
    db: "DB",
    statements: [
      { sql: "INSERT INTO t (name) VALUES (?)", params: ["grace"] },
      { sql: "SELECT count(*) AS n FROM t", params: [] },
    ],
  });
  expect(obj(arr(batch.results)[1]).results).toEqual([{ n: 2 }]);

  // a different bound name is a different database
  await expect(b.dispatch({ op: "d1.query", db: "OTHER", sql: "SELECT * FROM t", params: [] })).rejects.toThrow(
    "no such table",
  );
  await expect(b.dispatch({ op: "d1.query", db: "NOPE", sql: "SELECT 1", params: [] })).rejects.toThrow("not bound");
});

test("R2: put / get / head / list / delete on a bound bucket", async () => {
  const b = make({ bindings: { r2: ["ASSETS"] } });
  const put = await b.dispatch({
    op: "r2.put",
    bucket: "ASSETS",
    key: "a/1.txt",
    body: "hello",
    customMetadata: { k: "v" },
  });
  expect(put).toMatchObject({ ok: true });
  expect(obj(put.object).size).toBe(5);

  const got = await b.dispatch({ op: "r2.get", bucket: "ASSETS", key: "a/1.txt" });
  expect(got).toMatchObject({ ok: true, found: true, body: "hello" });
  expect(obj(got.object).customMetadata).toEqual({ k: "v" });

  const head = await b.dispatch({ op: "r2.head", bucket: "ASSETS", key: "a/1.txt" });
  expect(head).toMatchObject({ found: true });
  expect(head.body).toBeUndefined();

  await b.dispatch({ op: "r2.put", bucket: "ASSETS", key: "a/2.txt", body: "two" });
  await b.dispatch({ op: "r2.put", bucket: "ASSETS", key: "b/3.txt", body: "three" });
  const list = await b.dispatch({ op: "r2.list", bucket: "ASSETS", prefix: "a/" });
  expect(arr(list.objects).map((o) => obj(o).key)).toEqual(["a/1.txt", "a/2.txt"]);

  await b.dispatch({ op: "r2.delete", bucket: "ASSETS", key: "a/1.txt" });
  expect(await b.dispatch({ op: "r2.get", bucket: "ASSETS", key: "a/1.txt" })).toMatchObject({ found: false });
  await expect(b.dispatch({ op: "r2.put", bucket: "NOPE", key: "x", body: "y" })).rejects.toThrow("not bound");
});

test("R2: list paginates with a cursor", async () => {
  const b = make({ bindings: { r2: ["ASSETS"] } });
  for (let i = 0; i < 5; i++) await b.dispatch({ op: "r2.put", bucket: "ASSETS", key: `k${i}`, body: "x" });
  const p1 = await b.dispatch({ op: "r2.list", bucket: "ASSETS", limit: 2 });
  expect(arr(p1.objects).map((o) => obj(o).key)).toEqual(["k0", "k1"]);
  expect(p1.truncated).toBe(true);
  const p2 = await b.dispatch({ op: "r2.list", bucket: "ASSETS", limit: 2, cursor: p1.cursor });
  expect(arr(p2.objects).map((o) => obj(o).key)).toEqual(["k2", "k3"]);
});

test("Durable Object storage: get / put / delete / list / deleteAll scoped to (class, id)", async () => {
  const b = make({ bindings: { do: [{ binding: "COUNTER", className: "Counter" }] } });
  expect(await b.dispatch({ op: "do.storage.get", cls: "Counter", id: "a", key: "n" })).toMatchObject({ found: false });
  await b.dispatch({ op: "do.storage.put", cls: "Counter", id: "a", key: "n", value: "5" });
  await b.dispatch({ op: "do.storage.put", cls: "Counter", id: "a", key: "m", value: "9" });
  await b.dispatch({ op: "do.storage.put", cls: "Counter", id: "b", key: "n", value: "1" });
  expect(await b.dispatch({ op: "do.storage.get", cls: "Counter", id: "a", key: "n" })).toMatchObject({
    found: true,
    value: "5",
  });
  expect((await b.dispatch({ op: "do.storage.list", cls: "Counter", id: "a", prefix: "" })).entries).toEqual([
    ["m", "9"],
    ["n", "5"],
  ]);
  expect(await b.dispatch({ op: "do.storage.delete", cls: "Counter", id: "a", key: "m" })).toEqual({
    ok: true,
    deleted: true,
  });
  await b.dispatch({ op: "do.storage.delete_all", cls: "Counter", id: "a" });
  expect((await b.dispatch({ op: "do.storage.list", cls: "Counter", id: "a", prefix: "" })).entries).toEqual([]);
  expect(await b.dispatch({ op: "do.storage.get", cls: "Counter", id: "b", key: "n" })).toMatchObject({
    found: true,
    value: "1",
  });
  await expect(b.dispatch({ op: "do.storage.get", cls: "Nope", id: "a", key: "n" })).rejects.toThrow("not bound");
});

test("Analytics Engine: write is bound-gated; query reads back count + recent rows", async () => {
  const b = make({ bindings: { analytics: ["METRICS"] } });
  expect(await b.dispatch({ op: "ae.write", dataset: "METRICS", blobs: ["GET", "/a"], doubles: [1] })).toEqual({
    ok: true,
  });
  await b.dispatch({ op: "ae.write", dataset: "METRICS", blobs: ["POST", "/b"], doubles: [1] });
  await expect(b.dispatch({ op: "ae.write", dataset: "OTHER" })).rejects.toThrow("not bound");

  const q = await b.dispatch({ op: "ae.query", dataset: "METRICS", limit: 5 });
  expect(q.count).toBe(2);
  const rows = arr(q.rows);
  expect(obj(rows[0]).blobs).toEqual(["POST", "/b"]); // newest first
  await expect(b.dispatch({ op: "ae.query", dataset: "OTHER" })).rejects.toThrow("not bound");
});

test("Queues: send enqueues; the consumer delivers a batch and acked messages are removed", async () => {
  const delivered: JsonObject[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = obj(parseJsonValue(String(init?.body)));
    delivered.push(body);
    // ack all but the first
    return new Response(
      JSON.stringify({
        ack: arr(body.messages)
          .slice(1)
          .map((m) => obj(m).id),
        retry: [],
      }),
      { status: 200 },
    );
  };

  const b = make({ bindings: { queues: ["JOBS"] }, sproutUrl: "http://127.0.0.1:1/", fetchImpl });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: JSON.stringify({ n: 1 }) });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: JSON.stringify({ n: 2 }) });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: JSON.stringify({ n: 3 }) });

  // the consumer runs on a 500ms interval
  await Bun.sleep(900);
  expect(delivered.length).toBeGreaterThan(0);
  const first = obj(delivered[0]);
  expect(first.queue).toBe("JOBS");
  expect(arr(first.messages).length).toBe(3);

  await expect(b.dispatch({ op: "queue.send", queue: "NOPE", body: "x" })).rejects.toThrow("not bound");
});

test("assets.get: serves a bound file, falls back per not_found_handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-assets-"));
  const assetsDir = join(dir, "assets");
  mkdirSync(join(assetsDir, "sub"), { recursive: true });
  writeFileSync(join(assetsDir, "index.html"), "<h1>home</h1>");
  writeFileSync(join(assetsDir, "sub", "page.css"), "body{}");
  const write = (notFound: AssetManifest["notFound"]): void => {
    const m: AssetManifest = { notFound, runSproutFirst: false, files: walkAssets(assetsDir) };
    writeFileSync(join(dir, "assets.json"), JSON.stringify(m));
  };

  write("none");
  const b1 = make({ bindings: { assets: "ASSETS" }, assetsDir });
  expect(await b1.dispatch({ op: "assets.get", path: "/index.html" })).toMatchObject({
    found: true,
    status: 200,
    type: "text/html; charset=utf-8",
    body: "<h1>home</h1>",
  });
  expect(await b1.dispatch({ op: "assets.get", path: "/" })).toMatchObject({ found: true, body: "<h1>home</h1>" });
  expect(await b1.dispatch({ op: "assets.get", path: "/sub/page.css" })).toMatchObject({
    type: "text/css; charset=utf-8",
  });
  expect(await b1.dispatch({ op: "assets.get", path: "/missing" })).toMatchObject({ found: false, status: 404 });

  write("single-page-application");
  const b2 = make({ bindings: { assets: "ASSETS" }, assetsDir });
  expect(await b2.dispatch({ op: "assets.get", path: "/client/route" })).toMatchObject({
    found: true,
    status: 200,
    body: "<h1>home</h1>",
  });

  await expect(
    make({ bindings: { assets: "" }, assetsDir }).dispatch({ op: "assets.get", path: "/x" }),
  ).rejects.toThrow("not bound");
  rmSync(dir, { recursive: true, force: true });
});

test("cronMatches: fields, steps, ranges, lists (UTC)", () => {
  const at = (iso: string) => new Date(iso);
  expect(cronMatches("* * * * *", at("2026-08-31T04:07:00Z"))).toBe(true);
  expect(cronMatches("0 3 * * *", at("2026-08-31T03:00:00Z"))).toBe(true);
  expect(cronMatches("0 3 * * *", at("2026-08-31T04:00:00Z"))).toBe(false);
  expect(cronMatches("*/15 * * * *", at("2026-08-31T04:15:00Z"))).toBe(true);
  expect(cronMatches("*/15 * * * *", at("2026-08-31T04:16:00Z"))).toBe(false);
  expect(cronMatches("0 9-17 * * 1", at("2026-08-31T12:00:00Z"))).toBe(true); // 2026-08-31 is a Monday
  expect(cronMatches("0 9-17 * * 1", at("2026-08-30T12:00:00Z"))).toBe(false); // Sunday
  expect(cronMatches("0 0 1,15 * *", at("2026-08-15T00:00:00Z"))).toBe(true);
});

// #74 — a binding wired to an account-level resource stores in its own file
// under resourceDir, keyed by id, so the data outlives a "redeploy" (a new
// broker with a fresh per-deployment db but the same resourceDir).
test("resource-backed KV persists across brokers and is shared by id", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-res-"));
  try {
    const resourceDir = join(root, "resources");
    const kvId = "kv_0123456789abcdef01234567";
    mkdirSync(join(root, "dep-a"), { recursive: true });
    mkdirSync(join(root, "dep-b"), { recursive: true });

    const first = createBroker({
      db: join(root, "dep-a", "state.sqlite"),
      resourceDir,
      bindings: { kv: ["LINKS"], resources: { LINKS: { kind: "kv", id: kvId } } },
    });
    await first.dispatch({ op: "kv.put", ns: "LINKS", key: "a", value: "1" });
    first.close();
    // stored in the per-resource file, not a per-deployment one
    expect(existsSync(join(resourceDir, `${kvId}.sqlite`))).toBe(true);

    // a different deployment, different binding name, same id → same data
    const second = createBroker({
      db: join(root, "dep-b", "state.sqlite"),
      resourceDir,
      bindings: { kv: ["SHORTENER"], resources: { SHORTENER: { kind: "kv", id: kvId } } },
    });
    expect(await second.dispatch({ op: "kv.get", ns: "SHORTENER", key: "a" })).toEqual({
      ok: true,
      found: true,
      value: "1",
    });
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare-string binding still uses the per-broker db, not resourceDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-bare-"));
  try {
    const resourceDir = join(root, "resources");
    mkdirSync(join(root, "dep"), { recursive: true });
    const b = createBroker({ db: join(root, "dep", "state.sqlite"), resourceDir, bindings: { kv: ["CACHE"] } });
    await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k", value: "v" });
    b.close();
    expect(existsSync(resourceDir)).toBe(false);
    expect(existsSync(join(root, "dep", "state.sqlite"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token line is enforced by handlePayload", async () => {
  const b = make({ token: "t0k" });
  expect(await b.handlePayload(`wrong\n${JSON.stringify({ op: "ping" })}`)).toEqual({
    ok: false,
    error: "unauthorized",
  });
  expect(await b.handlePayload(`t0k\n${JSON.stringify({ op: "ping" })}`)).toMatchObject({ ok: true, op: "pong" });
});

test("listen(): framed request/reply over a real socket, delivered split", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  const server = listen(b, "127.0.0.1", 0);
  let recv = Buffer.alloc(0);
  let resolveReply: (s: string) => void;
  const reply = new Promise<string>((r) => {
    resolveReply = r;
  });
  try {
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        data(_s, chunk) {
          recv = Buffer.concat([recv, chunk]);
          if (recv.length >= 4 && recv.length >= 4 + recv.readUInt32LE(0)) {
            resolveReply(recv.subarray(4, 4 + recv.readUInt32LE(0)).toString("utf8"));
          }
        },
      },
    });
    const frame = encodeFrame({ op: "ping", msg: "x" });
    sock.write(frame.subarray(0, 3)); // header split mid-length
    await Bun.sleep(5);
    sock.write(frame.subarray(3));
    expect(JSON.parse(await reply)).toMatchObject({ ok: true, op: "pong", echo: "x" });
    sock.end();
  } finally {
    server.stop();
  }
});
