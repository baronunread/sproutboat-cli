#!/usr/bin/env bun
/**
 * Every small example, built and driven.
 *
 *   bun examples/smoke.ts          # all of them
 *   bun examples/smoke.ts kv d1    # just these
 *
 * The website's support table links a binding to the example that demonstrates
 * it, so an example that no longer builds turns that table into a claim nobody
 * checked. This is what checks it.
 *
 * Each example is built as a standalone binary rather than run under `dev`,
 * because that needs no broker, no control plane and no ports beyond the one
 * it listens on — and it exercises the binding ops end to end all the same.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandalone } from "../src/standalone-build";
import { bundleHandler } from "../src/bundle";
import { parseConfig } from "../src/config";
import type { JsonValue } from "../src/json";

type Check = (base: string, ok: (name: string, cond: boolean, detail?: JsonValue) => void) => Promise<void>;

const text = async (url: string, init?: RequestInit) => (await fetch(url, init)).text();

const EXAMPLES = {
  hello: async (base, ok) => {
    ok("greets the world", (await text(base + "/")) === "Hello, world!\n");
    ok("reads the query string", (await text(base + "/?name=sprout")) === "Hello, sprout!\n");
  },

  kv: async (base, ok) => {
    await fetch(base + "/greeting", { method: "PUT", body: "hello" });
    ok("get returns what put stored", (await text(base + "/greeting")) === "hello\n");
    ok("list includes the key", (await text(base + "/")).includes("greeting"));
    ok("a missing key is a 404", (await fetch(base + "/nope")).status === 404);
    await fetch(base + "/greeting", { method: "DELETE" });
    ok("delete removes it", (await fetch(base + "/greeting")).status === 404);
  },

  d1: async (base, ok) => {
    const created = await (await fetch(base + "/", { method: "POST", body: '{"title":"read the docs"}' })).json();
    ok("insert returns a row id", Number(created.id) > 0, created);
    const rows = await (await fetch(base + "/")).json();
    ok(
      "select returns the row",
      rows.some((r: { title: string }) => r.title === "read the docs"),
      rows,
    );
  },

  r2: async (base, ok) => {
    await fetch(base + "/notes.txt", { method: "PUT", body: "the file contents" });
    const got = await fetch(base + "/notes.txt");
    ok("get returns the body", (await got.text()) === "the file contents");
    ok("get returns an etag", !!got.headers.get("etag"));
    ok("list includes the key", (await text(base + "/")).includes("notes.txt"));
  },

  queue: async (base, ok) => {
    const sent = await fetch(base + "/", { method: "POST", body: '{"email":"someone@example.com"}' });
    ok("send accepts without waiting", sent.status === 202);
    // The consumer runs out of band — poll rather than assume it already has.
    let delivered = false;
    for (let i = 0; i < 40 && !delivered; i++) {
      delivered = (await text(base + "/")).includes("someone@example.com");
      if (!delivered) await Bun.sleep(250);
    }
    ok("the consumer received the message", delivered);
  },

  cron: async (base, ok) => {
    // Only that the handler and binding work: waiting for a */1 tick would put
    // a minute into every run. The cron firing itself is covered by the
    // kitchen-sink conformance suite.
    ok("reports a tick count before any tick", (await text(base + "/")).startsWith("0 ticks"));
  },

  "durable-object": async (base, ok) => {
    ok("first call to a name is 1", (await text(base + "/downloads")) === "downloads: 1\n");
    ok("the same name keeps counting", (await text(base + "/downloads")) === "downloads: 2\n");
    ok("a different name is its own object", (await text(base + "/signups")) === "signups: 1\n");
  },

  assets: async (base, ok) => {
    const home = await fetch(base + "/");
    ok("serves index.html from public/", (await home.text()).includes("Served from public/"));
    ok("with an html content-type", (home.headers.get("content-type") || "").includes("text/html"));
    const api = await (await fetch(base + "/api/time")).json();
    ok("run_sprout_first gives /api to the handler", !Number.isNaN(Date.parse(String(api.now))), api);
  },
} satisfies Record<string, Check>;

type Name = keyof typeof EXAMPLES;
const isName = (v: string): v is Name => Object.hasOwn(EXAMPLES, v);

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const chosen = probe.port;
  probe.stop(true);
  return chosen;
}

const HERE = import.meta.dir;
const wanted = process.argv.slice(2);
for (const name of wanted) if (!isName(name)) throw new Error(`no such example: ${name}`);
const names: Name[] = wanted.length ? wanted.filter(isName) : Object.keys(EXAMPLES).filter(isName);

let failures = 0;
for (const name of names) {
  const dir = join(HERE, name);
  const workdir = mkdtempSync(join(tmpdir(), `sb-smoke-${name}-`));
  const parsed = parseConfig(readFileSync(join(dir, "sproutboat.jsonc"), "utf8"));
  if (!parsed.ok) throw new Error(`${name}: bad config: ${parsed.errors.join("; ")}`);
  const config = parsed.value;

  const sourcePath = join(dir, config.main);
  const bundle = await bundleHandler(sourcePath, dir);
  const built = await buildStandalone({
    projectDir: dir,
    config,
    sourcePath,
    source: bundle.code,
    target: "host",
    outPath: join(workdir, name),
  });

  const port = freePort();
  const child = Bun.spawn([built.outPath], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: String(port), SB_DATA_DIR: join(workdir, "data") },
  });
  const base = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      await fetch(base + "/", { signal: AbortSignal.timeout(2000) });
      up = true;
    } catch {
      await Bun.sleep(100);
    }
  }

  console.log(`\n${name}  (${(built.bytes / 1_000_000).toFixed(1)} MB)`);
  if (!up) {
    console.log(`  FAIL  never listened on ${port}\n${await new Response(child.stderr).text()}`);
    failures++;
  } else {
    await EXAMPLES[name](base, (check, cond, detail) => {
      if (cond) console.log("  ok    " + check);
      else {
        console.log(`  FAIL  ${check}${detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
        failures++;
      }
    });
  }

  child.kill(9);
  await child.exited;
  rmSync(workdir, { recursive: true, force: true });
}

console.log(failures === 0 ? `\n${names.length} examples, all green.` : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
