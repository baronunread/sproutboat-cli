import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { buildStandalone } from "./standalone-build";
import { compileSprout, EMPTY_BINDINGS, loadPrelude, porfforArgs, wrapNativeFetchHandler } from "./compile";
import { ensurePorffor } from "./porffor-toolchain";
import { restoreSymbolDefines } from "./native-restore";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function command(argv: string[], env = process.env) {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function start(binary: string, data: string, capture: boolean, args: string[] = []) {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const child = Bun.spawn([binary, ...args], {
    env: {
      ...process.env,
      PATH: "/nonexistent",
      PORT: String(port),
      SB_DATA_DIR: data,
      POISON: "no",
      SB_LTX_ENABLE: capture ? "1" : "0",
      SB_LTX_DATABASE: "DB",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await stdout;
    return stderr;
  };
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      if ((await fetch(url)).ok) return { url, child, stop };
    } catch {}
    if (child.exitCode !== null) break;
    await Bun.sleep(20);
  }
  throw new Error(`native restore test server failed: ${await stop()}`);
}

test("native restore symbol namespace is separate and fails on an unexpected inventory", () => {
  expect(
    restoreSymbolDefines(
      "0000 B porf_mem\n0010 T porf_native_fetch_runtime_init\n0020 T sb_cli_restore_dispatch\n",
      false,
    ),
  ).toBe(
    "#define porf_mem sb_ltx_trusted_porf_mem\n#define porf_native_fetch_runtime_init sb_ltx_trusted_porf_native_fetch_runtime_init\n",
  );
  expect(restoreSymbolDefines("0000 B _porf_mem\n0010 T _porf_native_fetch_runtime_init\n", true)).toContain(
    "sb_ltx_trusted_porf_mem",
  );
  expect(() => restoreSymbolDefines("0000 T changed\n", false)).toThrow("inventory changed");
});

test("one native standalone restores before tenant init; ordinary C and arguments stay unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-cli-native-restore-"));
  roots.push(root);
  const entry = join(root, "index.js");
  const source = `if (env.POISON === 'yes') throw new Error('TENANT INITIALIZED');
export default { async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/rollback') {
    try { await env.DB.batch([env.DB.prepare("INSERT INTO t VALUES(99,'rolled back')"), env.DB.prepare("INSERT INTO t VALUES(1,'duplicate')")]); }
    catch { return new Response('rolled back'); }
    return new Response('batch unexpectedly committed', {status:500});
  }
  if (path === '/sql') await env.DB.exec(await request.text());
  return new Response('ok');
}};`;
  await writeFile(entry, source);
  const config = {
    name: "restore-test",
    main: "index.js",
    compatibility_date: "2026-10-24",
    d1_databases: ["DB"],
    secrets: ["POISON"],
  };
  const input = { projectDir: root, config, sourcePath: entry, source, target: "host" as const };
  const ordinary = await buildStandalone({ ...input, outPath: join(root, "ordinary") });
  const enabled = await buildStandalone({ ...input, withRestore: true, outPath: join(root, "enabled") });
  const runtimeEnv = { ...process.env, PATH: "/nonexistent", POISON: "yes", SB_DATA_DIR: join(root, "must-not-open") };
  const restore = (generation: string, output: string, txid = "") =>
    command(
      [
        enabled.outPath,
        "ltx-restore",
        "--generation",
        generation,
        "--output",
        output,
        ...(txid ? ["--txid", txid] : []),
      ],
      runtimeEnv,
    );
  assert.equal((await command([enabled.outPath, "ltx-restore", "--help"], runtimeEnv)).code, 0);
  for (const args of [
    [],
    ["--generation", "x"],
    ["--unknown", "x"],
    ["--generation", "x", "--output", "y", "--txid", "0"],
    ["--generation", "x", "--output", "y", "--txid", "18446744073709551616"],
    ["--generation", "x", "--output", "y", "--txid", "1e2"],
  ]) {
    assert.equal((await command([enabled.outPath, "ltx-restore", ...args], runtimeEnv)).code, 2);
  }
  await mkdir(join(root, "data/d1"), { recursive: true });
  const seed = new Database(join(root, "data/d1/DB.sqlite"));
  seed.exec("CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT)");
  seed.close();
  const live = await start(enabled.outPath, join(root, "data"), true);
  let generation = "",
    output = join(root, "restored.sqlite"),
    sourceBytes: Buffer;
  try {
    async function sql(value: string) {
      const reply = await fetch(live.url + "/sql", { method: "POST", body: value });
      assert(reply.ok, await reply.text());
    }
    await sql("INSERT INTO t VALUES(1,'first')");
    const spool = join(root, "data/d1/DB.sqlite.ltx");
    generation = join(spool, (await readFile(join(spool, "position"), "utf8")).split("\n")[1]);
    const active = await restore(generation, output);
    assert.equal(active.code, 1);
    assert(active.stderr.includes("active"));
    for (let id = 2; id <= 12; id++) await sql(`INSERT INTO t VALUES(${id},hex(zeroblob(1000)))`);
    assert((await fetch(live.url + "/rollback")).ok);
    await sql("UPDATE t SET value='updated' WHERE id % 3 = 0");
    await sql("DELETE FROM t WHERE id > 8");
  } finally {
    await live.stop();
  }
  sourceBytes = await readFile(join(root, "data/d1/DB.sqlite"));
  const completed = await restore(generation, output);
  assert.equal(completed.code, 0, completed.stderr);
  assert(!completed.stderr.includes("TENANT INITIALIZED"));
  const result: { txid: string; bytes: number } = JSON.parse(completed.stdout);
  assert(BigInt(result.txid) > 2n);
  assert.equal(result.bytes, sourceBytes.length);
  assert.deepEqual(await readFile(output), sourceBytes);
  const db = new Database(output);
  assert.equal(db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check, "ok");
  db.close();
  assert(!(await Bun.file(runtimeEnv.SB_DATA_DIR + "/d1/DB.sqlite").exists()));
  assert.equal((await restore(generation, output)).code, 1);
  assert.deepEqual(await readFile(output), sourceBytes);
  const point = join(root, "point.sqlite");
  assert.equal((await restore(generation, point, "2")).code, 0);
  const pointDb = new Database(point);
  assert.equal(pointDb.query<{ n: number }, []>("SELECT count(*) n FROM t").get()?.n, 1);
  pointDb.close();
  const sidecar = join(root, "sidecar.sqlite");
  await writeFile(sidecar + "-wal", "keep");
  assert.equal((await restore(generation, sidecar)).code, 1);
  assert.equal(await readFile(sidecar + "-wal", "utf8"), "keep");
  const corrupt = join(root, "corrupt");
  await cp(generation, corrupt, { recursive: true });
  const files = (await readdir(corrupt)).filter((name) => name.endsWith(".ltx")).sort();
  const bad = await readFile(join(corrupt, files[1]));
  bad[bad.length - 1] ^= 1;
  await writeFile(join(corrupt, files[1]), bad);
  assert.equal((await restore(corrupt, join(root, "bad.sqlite"))).code, 1);
  assert(!(await readdir(root)).some((name) => name.startsWith("bad.sqlite.restore-")));
  await rm(join(corrupt, files[1]));
  assert.equal((await restore(corrupt, join(root, "gap.sqlite"))).code, 1);
  await symlink(join(generation, files[1]), join(corrupt, files[1]));
  assert.equal((await restore(corrupt, join(root, "symlink.sqlite"))).code, 1);
  const race = join(root, "race.sqlite");
  assert.deepEqual(
    (await Promise.all([restore(generation, race), restore(generation, race)])).map((r) => r.code).sort(),
    [0, 1],
  );
  assert.deepEqual(await readFile(race), sourceBytes);

  // Kill an in-progress large restore, then retry against the same immutable generation.
  const largeData = join(root, "large-data");
  await mkdir(join(largeData, "d1"), { recursive: true });
  const largeSource = join(largeData, "d1/DB.sqlite");
  const largeDb = new Database(largeSource);
  largeDb.exec("CREATE TABLE payload(data BLOB); INSERT INTO payload VALUES(zeroblob(16777216))");
  largeDb.close();
  const largeWorker = await start(enabled.outPath, largeData, true);
  let largeGeneration = "";
  try {
    const r = await fetch(largeWorker.url + "/sql", { method: "POST", body: "SELECT 1" });
    assert(r.ok, await r.text());
    const spool = join(largeData, "d1/DB.sqlite.ltx");
    largeGeneration = join(spool, (await readFile(join(spool, "position"), "utf8")).split("\n")[1]);
  } finally {
    await largeWorker.stop();
  }
  const interrupted = join(root, "interrupted.sqlite");
  const killed = Bun.spawn([enabled.outPath, "ltx-restore", "--generation", largeGeneration, "--output", interrupted], {
    env: runtimeEnv,
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let temporarySeen = false;
    for (let attempt = 0; attempt < 2000; attempt++) {
      if ((await readdir(root)).some((name) => name.startsWith("interrupted.sqlite.restore-"))) {
        temporarySeen = true;
        break;
      }
      if (killed.exitCode !== null) break;
      await Bun.sleep(5);
    }
    assert(temporarySeen, "could not interrupt before temporary publication");
  } finally {
    if (killed.exitCode === null) killed.kill("SIGKILL");
    await killed.exited;
  }
  assert.notEqual(killed.exitCode, 0);
  assert(!(await Bun.file(interrupted).exists()), "SIGKILL published incomplete output");
  const retried = await restore(largeGeneration, interrupted);
  assert.equal(retried.code, 0, retried.stderr);
  assert.deepEqual(await readFile(interrupted), await readFile(largeSource));

  // Same ordinary compile input as the released wrapper/compile path, without the new build option.
  const generated = join(root, "ordinary-input.js");
  const bindings = { ...EMPTY_BINDINGS, d1: ["DB"], secrets: ["POISON"], vars: {}, resources: {} };
  await compileSprout({
    sourcePath: entry,
    source,
    generatedPath: generated,
    outPath: join(root, "unused"),
    vars: {},
    bindings,
    transport: "embedded",
    appName: config.name,
    compatibilityDate: config.compatibility_date,
    emitOnly: true,
  });
  const baseline = wrapNativeFetchHandler(
    source,
    await loadPrelude("embedded"),
    {},
    bindings,
    undefined,
    config.compatibility_date,
    config.name,
    undefined,
    "embedded",
  );
  assert.equal(await readFile(generated, "utf8"), baseline);
  const porffor = await ensurePorffor(),
    cOutput = join(root, "c");
  const emit = async () => {
    const r = await command([
      process.execPath,
      resolve(import.meta.dir, "main.ts"),
      "__porffor",
      join(porffor, "runtime/index.js"),
      "c",
      generated,
      "-o",
      cOutput,
    ]);
    assert.equal(r.code, 0, r.stderr);
    return Promise.all(["app.c", "server.cpp"].map((name) => readFile(join(cOutput, name))));
  };
  const actualC = await emit();
  await writeFile(generated, baseline);
  const baselineC = await emit();
  assert.deepEqual(actualC, baselineC, "default app/server C changed");
  assert(!porfforArgs(generated, "out", "host", "release").some((arg) => arg.includes("native-bytes")));
  const noRestore = await start(ordinary.outPath, join(root, "ordinary-data"), false, [
    "ltx-restore",
    "--generation",
    generation,
    "--output",
    join(root, "not-dispatched.sqlite"),
  ]);
  try {
    assert(!(await Bun.file(join(root, "not-dispatched.sqlite")).exists()));
  } finally {
    await noRestore.stop();
  }
  const poisoned = await command([ordinary.outPath], runtimeEnv);
  assert.notEqual(poisoned.code, 0);
  assert(poisoned.stderr.includes("TENANT INITIALIZED"));
}, 1_200_000); // two cold standalone builds (ordinary and with restore): 476 s on CI at v0.47.0, 573 to 600+ s on 0.48.0 (a larger prelude: D1, Durable Objects, Queues and crypto parity, then the database-client fixes), so 600 s no longer fits
