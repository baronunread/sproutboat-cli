import { openLocalKv } from "./local-kv";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonObject } from "./json";
import { createBroker, type Broker } from "./broker";

let project: string;
let data: string;
let broker: Broker;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "sb-local-kv-"));
  data = join(project, "state");
  await mkdir(data);
  await writeFile(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({
      name: "local-app",
      main: "src/missing.js",
      compatibility_date: "2026-09-28",
      kv_namespaces: ["SESSIONS"],
    }),
  );
  broker = createBroker({ db: join(data, "store.sqlite"), bindings: { kv: ["SESSIONS", "OTHER"] } });
});

afterEach(async () => {
  broker.close();
  await rm(project, { recursive: true, force: true });
});

async function cli(args: string[], target: string[] = ["--data-dir", data]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "kv", ...args, "--local", ...target], {
    cwd: project,
    env: {
      ...process.env,
      NO_COLOR: "1",
      SPROUTBOAT_TOKEN: "",
      SPROUTBOAT_API_URL: "http://127.0.0.1:9",
      SPROUTBOAT_CONFIG_DIR: join(project, "no-credentials"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("local KV works without credentials or source and shares the live runtime store", async () => {
  const put = await cli(["key", "put", "SESSIONS", "session", "héllo"]);
  expect(put.code, put.stderr).toBe(0);
  expect(put.stderr).toContain(join(data, "store.sqlite"));
  expect(await broker.dispatch({ op: "kv.get", ns: "SESSIONS", key: "session" })).toMatchObject({ value: "héllo" });
  const got = await cli(["key", "get", "SESSIONS", "session", "--text"]);
  expect(got.code).toBe(0);
  expect(got.stdout).toBe("héllo\n");
  expect((await cli(["key", "delete", "SESSIONS", "session"])).code).toBe(1);
  expect((await cli(["key", "delete", "SESSIONS", "session", "--yes"])).code).toBe(0);
});

test("literal prefixes, cursors and expiration are respected", async () => {
  for (const key of ["a%:1", "a%:2", "abc", "expired"]) {
    const entry: JsonObject = { op: "kv.put", ns: "SESSIONS", key, value: "v" };
    if (key === "expired") entry.expiration = 1;
    await broker.dispatch(entry);
  }
  const first = JSON.parse((await cli(["key", "list", "SESSIONS", "--prefix", "a%", "--limit", "1"])).stdout);
  expect(first).toEqual({ keys: ["a%:1"], cursor: "a%:1" });
  const next = JSON.parse((await cli(["key", "list", "SESSIONS", "--prefix", "a%", "--cursor", first.cursor])).stdout);
  expect(next).toEqual({ keys: ["a%:2"], cursor: null });
  expect((await cli(["key", "get", "SESSIONS", "expired"])).code).toBe(1);
});

test("binary values round-trip through files and restorable exports", async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const input = join(project, "input.bin");
  const output = join(project, "output.bin");
  const dump = join(project, "dump.json");
  await writeFile(input, bytes);
  expect((await cli(["key", "put", "SESSIONS", "binary", "--path", input, "--binary"])).code).toBe(0);
  expect((await cli(["key", "get", "SESSIONS", "binary", "--output", output])).code).toBe(0);
  expect(Buffer.from(await Bun.file(output).arrayBuffer())).toEqual(bytes);
  expect((await cli(["key", "get", "SESSIONS", "binary", "--text"])).code).toBe(1);
  expect((await cli(["export", "SESSIONS", "--output", dump])).code).toBe(0);
  expect(JSON.parse(await Bun.file(dump).text())).toEqual([
    { key: "binary", value: bytes.toString("base64"), base64: true },
  ]);
  await cli(["key", "delete", "SESSIONS", "binary", "--yes"]);
  expect((await cli(["bulk", "put", "SESSIONS", dump])).code).toBe(0);
  expect(await broker.dispatch({ op: "kv.get", ns: "SESSIONS", key: "binary" })).toMatchObject({
    value: bytes.toString("latin1"),
    binary: true,
  });
});

test("export covers more than the binding list's 1000-row cap and isolates namespaces", async () => {
  for (let index = 0; index < 1005; index++)
    await broker.dispatch({ op: "kv.put", ns: "SESSIONS", key: `k${String(index).padStart(4, "0")}`, value: "v" });
  await broker.dispatch({ op: "kv.put", ns: "OTHER", key: "other", value: "private" });
  const dump = join(project, "many.json");
  expect((await cli(["export", "SESSIONS", "--output", dump])).code).toBe(0);
  const entries = JSON.parse(await Bun.file(dump).text());
  expect(entries.length).toBe(1005);
  expect(entries.some((entry: { key: string }) => entry.key === "other")).toBe(false);
});

test("invalid bulk entries roll back their batch", async () => {
  const input = join(project, "bad.json");
  await writeFile(
    input,
    JSON.stringify([
      { key: "first", value: "v" },
      { key: "bad", value: "!", base64: true },
    ]),
  );
  expect((await cli(["bulk", "put", "SESSIONS", input])).code).toBe(1);
  expect(await broker.dispatch({ op: "kv.get", ns: "SESSIONS", key: "first" })).toMatchObject({ found: false });
});

test("missing, ambiguous and unbound targets fail without creating stores", async () => {
  const missing = join(project, "does-not-exist");
  expect((await cli(["key", "list", "SESSIONS"], ["--data-dir", missing])).code).toBe(1);
  expect(await Bun.file(join(missing, "state.sqlite")).exists()).toBe(false);
  expect((await cli(["key", "list", "UNBOUND"])).stderr).toContain("no KV binding");
  await writeFile(join(data, "state.sqlite"), "wrong");
  expect((await cli(["key", "list", "SESSIONS"])).stderr).toContain("ambiguous data directory");
  expect((await cli(["key", "list", "SESSIONS", "--remote"])).stderr).toContain("choose --local or --remote");
});

test("default dev target resolves configured resource IDs", async () => {
  const id = "kv_0123456789abcdef01234567";
  await writeFile(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({
      name: "local-app",
      main: "src/missing.js",
      compatibility_date: "2026-09-28",
      kv_namespaces: [{ binding: "SESSIONS", id }],
    }),
  );
  await mkdir(join(project, ".sproutboat/dev"), { recursive: true });
  const dev = createBroker({
    db: join(project, ".sproutboat/dev/state.sqlite"),
    resourceDir: join(project, ".sproutboat/dev/resources"),
    bindings: { kv: ["SESSIONS"], resources: { SESSIONS: { kind: "kv", id } } },
  });
  try {
    await dev.dispatch({ op: "kv.put", ns: "SESSIONS", key: "dev", value: "correct" });
    const got = await cli(["key", "get", "SESSIONS", "dev", "--text"], []);
    expect(got.code).toBe(0);
    expect(got.stdout).toBe("correct\n");
    expect(got.stderr).toContain(`${id}.sqlite`);
  } finally {
    dev.close();
  }
});

test("local export and restore preserve absolute expiration", async () => {
  const expiration = Math.floor(Date.now() / 1000) + 3600;
  await broker.dispatch({ op: "kv.put", ns: "SESSIONS", key: "temporary", value: "v", expiration });
  const dump = join(project, "expiry.json");
  expect((await cli(["export", "SESSIONS", "--output", dump])).code).toBe(0);
  expect(JSON.parse(await Bun.file(dump).text())).toEqual([{ key: "temporary", value: "v", expiration }]);
  await cli(["key", "delete", "SESSIONS", "temporary", "--yes"]);
  expect((await cli(["bulk", "put", "SESSIONS", dump])).code).toBe(0);
  const again = join(project, "again.json");
  expect((await cli(["export", "SESSIONS", "--output", again])).code).toBe(0);
  expect(await Bun.file(again).text()).toBe(await Bun.file(dump).text());
});

test("paginated local reads keep a consistent snapshot while the runtime writes", async () => {
  await broker.dispatch({ op: "kv.put", ns: "SESSIONS", key: "one", value: "before" });
  const local = openLocalKv(join(data, "store.sqlite"), "SESSIONS", false);
  try {
    await local.request("/keys?limit=1");
    await broker.dispatch({ op: "kv.put", ns: "SESSIONS", key: "one", value: "after" });
    expect(await (await local.request("/keys/one")).json()).toMatchObject({ value: "before" });
    expect(await broker.dispatch({ op: "kv.get", ns: "SESSIONS", key: "one" })).toMatchObject({ value: "after" });
  } finally {
    local.close();
  }
});

test("output cannot replace the source database even with --force", async () => {
  const result = await cli(["export", "SESSIONS", "--output", join(data, "store.sqlite"), "--force"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("output cannot replace");
  expect(await broker.dispatch({ op: "kv.get", ns: "SESSIONS", key: "missing" })).toMatchObject({ found: false });
});
