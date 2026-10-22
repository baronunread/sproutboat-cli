#!/usr/bin/env bun
/**
 * Every small example, built and driven.
 *
 *   bun examples/smoke.ts          # all of them
 *   bun examples/smoke.ts kv d1    # just these
 *   SMOKE_CONCURRENCY=1 bun examples/smoke.ts   # one at a time (default 4)
 *
 * Examples build and run in a pool. Each one already has its own project dir
 * (and so its own `.sproutboat/` artifact and Porffor unit dirs), and gets its
 * own temp dir, data dir and port here. The shared toolchain caches are warmed
 * once before the pool starts, so concurrent builds only ever read them.
 *
 * The website's support table links a binding to the example that demonstrates
 * it, so an example that no longer builds turns that table into a claim nobody
 * checked. This is what checks it.
 *
 * Each example is built as a standalone binary rather than run under `dev`,
 * because that needs no broker, no control plane and no ports beyond the one
 * it listens on — and it exercises the binding ops end to end all the same.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandalone } from "../src/standalone-build";
import { bundleHandler } from "../src/bundle";
import { parseConfig } from "../src/config";
import type { JsonValue } from "../src/json";
import { prunePorfforBuilds } from "../src/compile";
import { ensurePorffor } from "../src/porffor-toolchain";
import { ensurePorfforPatched } from "../src/patch-porffor";
import { ensureUWebSocketsHost, UwsUnavailableError } from "../src/toolchain";
import { ensureSqliteObject } from "../src/sqlite";
import { ensureBearssl } from "../src/bearssl";

type Check = (base: string, ok: (name: string, cond: boolean, detail?: JsonValue) => void) => Promise<void>;

const fetch = (url: string, init?: RequestInit) =>
  globalThis.fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });

const text = async (url: string, init?: RequestInit) => (await fetch(url, init)).text();

const EXAMPLES = {
  hello: async (base, ok) => {
    ok("greets the world", (await text(base + "/")) === "Hello, world!\n");
    ok("reads the query string", (await text(base + "/?name=sprout")) === "Hello, sprout!\n");
  },

  "cf-json": async (base, ok) => {
    const response = await fetch(base + "/");
    ok("returns a JSON content type", response.headers.get("content-type")?.includes("application/json") === true);
    ok("returns the JSON object", JSON.stringify(await response.json()) === '{"hello":"world"}');
  },

  "cf-cookies": async (base, ok) => {
    ok(
      "reads a named cookie",
      (await text(base + "/", { headers: { cookie: "other=1; __uid=abc=123" } })) === "abc=123",
    );
    ok(
      "does not match a prefix",
      (await text(base + "/", { headers: { cookie: "__uid_extra=no" } })) === "No cookie with name: __uid",
    );
  },

  "cf-redirects": async (base, ok) => {
    const redirect = await fetch(base + "/old-guide?from=search", { redirect: "manual" });
    ok("redirects a mapped path", redirect.status === 301 && redirect.headers.get("location") === base + "/guide", {
      status: redirect.status,
      location: redirect.headers.get("location"),
    });
    ok("does not redirect an unmapped path", (await fetch(base + "/unknown", { redirect: "manual" })).status === 404);
  },

  "cf-headers": async (base, ok) => {
    const response = await fetch(base + "/");
    ok("returns the page", (await response.text()) === "Protected page");
    ok(
      "sets security headers",
      response.headers.get("x-content-type-options") === "nosniff" &&
        response.headers.get("x-frame-options") === "DENY" &&
        response.headers.get("content-security-policy") === "default-src 'none'",
    );
  },

  "cf-post": async (base, ok) => {
    const json = await fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"message":"hello"}',
    });
    ok(
      "reads JSON bodies",
      json.status === 200 && JSON.stringify(await json.json()) === '{"received":{"message":"hello"}}',
    );
    const invalid = await fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    ok("rejects malformed JSON", invalid.status === 400);
    ok(
      "reads text bodies",
      (await text(base + "/", { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" })) ===
        "hello",
    );
    ok(
      "rejects unsupported media",
      (
        await fetch(base + "/", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: "a",
        })
      ).status === 415,
    );
  },

  "worker-return-json": async (base, ok) => {
    const response = await fetch(base + "/");
    ok("returns the original JSON", response.status === 200 && (await response.text()) === '{"hello":"world"}');
    ok("sets a JSON content type", response.headers.get("content-type")?.includes("application/json") === true);
  },

  "worker-cookie-parsing": async (base, ok) => {
    ok("reads the original cookie", (await text(base + "/", { headers: { cookie: "other=1; __uid=abc" } })) === "abc");
    ok("reports a missing cookie", (await text(base + "/")) === "No cookie with name: __uid");
  },

  "worker-redirect": async (base, ok) => {
    const response = await fetch(base + "/anything", { redirect: "manual" });
    ok(
      "returns the original 301 redirect",
      // Response.redirect sends the parsed URL, serialized (Fetch spec; workerd does the
      // same): "https://example.com" goes out as "https://example.com/".
      response.status === 301 && response.headers.get("location") === "https://example.com/",
      {
        status: response.status,
        location: response.headers.get("location"),
      },
    );
  },

  "workers-contract": async (base, ok) => {
    ok("passes env second and ctx third", (await text(base + "/")) === "sproutboat:true");
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

  // The d1 example rebuilt at compatibility date 2026-10-22, where request.body is a
  // ReadableStream and fetch() is asynchronous. It catches an example handler that only
  // works before that date, which no example's own config would.
  "d1@2026-10-22": async (base, ok) => {
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

  analytics: async (base, ok) => {
    await fetch(base + "/", { method: "POST", body: '{"path":"/pricing"}' });
    const rows = await (await fetch(base + "/")).json();
    ok(
      "query returns the recorded point",
      rows.some((r: { blobs: string[] }) => r.blobs[0] === "/pricing"),
      rows,
    );
  },

  // Request semantics from compatibility date 2026-10-23, as workerd has them.
  request: async (base, ok) => {
    const forwarded = await (
      await fetch(base + "/forward", { method: "POST", headers: { "x-from": "client" }, body: "hi é" })
    ).json();
    ok(
      "a copy of the incoming request keeps its method, headers and body",
      JSON.stringify(forwarded) ===
        JSON.stringify({
          url: "https://upstream.example/echo",
          method: "POST",
          from: "client",
          body: "hi é",
          incomingUsed: true,
        }),
      forwarded,
    );
    const rules = await (await fetch(base + "/rules")).json();
    ok(
      "init merges, clone() tees, a used body cannot be copied, GET refuses a body, incoming headers are immutable",
      JSON.stringify(rules) ===
        JSON.stringify({
          merged: ["PUT", [["x-b", "2"]], "abc", "abc"],
          originalUsed: true,
          copyUsed: "TypeError: Cannot reconstruct a Request with a used body.",
          getWithBody: "TypeError: Request with a GET or HEAD method cannot have a body.",
          immutable: "TypeError: Can't modify immutable headers.",
        }),
      rules,
    );
  },

  "outbound-fetch": async (base, ok) => {
    ok("fetches a public host", (await text(base + "/")).startsWith("example.com answered with 200"));
    ok("refuses a private address", (await fetch(base + "/blocked")).status === 403);
  },

  ratelimit: async (base, ok) => {
    let last = 200;
    for (let i = 0; i < 4; i++) last = (await fetch(base + "/limited")).status;
    ok("the 4th request over the limit is a 429", last === 429);
  },

  "vars-secrets": async (base, ok) => {
    ok(
      "reads the baked-in var and the injected secret",
      (await text(base + "/")) === "hej, your key ends in ...-key\n",
    );
  },
} satisfies Record<string, Check>;

// Everything else spawns with just PORT/SB_DATA_DIR; vars-secrets also needs
// its one declared secret, which a standalone binary reads from the process
// environment rather than anything sproutboat.jsonc can supply.
const EXTRA_ENV = {
  "vars-secrets": { API_KEY: "demo-key" },
} satisfies Partial<Record<Name, Record<string, string>>>;

type Name = keyof typeof EXAMPLES;
const isName = (v: string): v is Name => Object.hasOwn(EXAMPLES, v);

// Ports handed out in this run. The kernel picks a free one, but with several
// examples starting at once two probes can be handed the same port before
// either child binds it, and then one example's checks talk to another's
// server. Remembering every port given out rules that out.
const takenPorts = new Set<number>();
function freePort(): number {
  for (;;) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const chosen = probe.port;
    probe.stop(true);
    if (!takenPorts.has(chosen)) {
      takenPorts.add(chosen);
      return chosen;
    }
  }
}

const HERE = import.meta.dir;
const wanted = process.argv.slice(2);
for (const name of wanted) if (!isName(name)) throw new Error(`no such example: ${name}`);
const names: Name[] = wanted.length ? wanted.filter(isName) : Object.keys(EXAMPLES).filter(isName);

const rawConcurrency = process.env.SMOKE_CONCURRENCY ?? "4";
const concurrency = Number(rawConcurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error(`SMOKE_CONCURRENCY must be a positive integer, got "${rawConcurrency}"`);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// Live children and temp dirs, so an interrupted run does not leave servers
// listening or temp dirs behind.
type LiveEntry = { child?: ReturnType<typeof Bun.spawn>; workdir: string };
const live = new Set<LiveEntry>();
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    for (const entry of live) {
      if (entry.child && entry.child.exitCode === null) entry.child.kill(9);
      rmSync(entry.workdir, { recursive: true, force: true });
    }
    process.exit(code);
  });
}

/**
 * Fill the caches every build shares before any build runs. Each has its own
 * lock, but a waiter gives up after 30 seconds, and a cold BearSSL or
 * uSockets build can take longer than that while three other builds wait on
 * it. Doing it once up front also settles Porffor's build-dir pruning, which
 * otherwise runs in the background of the first compile and could remove a
 * stale unit dir another example is compiling into at that moment.
 */
async function warmSharedCaches(): Promise<void> {
  await prunePorfforBuilds();
  await ensurePorfforPatched(await ensurePorffor());
  try {
    await ensureUWebSocketsHost();
  } catch (error) {
    // compileSprout falls back to Porffor's own git + make build when asked to.
    if (!(error instanceof UwsUnavailableError && process.env.SPROUTBOAT_BUILD_UWS_FROM_SOURCE === "1")) throw error;
  }
  await Promise.all([ensureSqliteObject({ target: "host" }), ensureBearssl({ target: "host" })]);
}

type Result = { name: Name; failed: number; ms: number; report: string };

async function runExample(name: Name): Promise<Result> {
  const started = performance.now();
  const lines: string[] = [];
  let failed = 0;
  let size = "";
  let stderr = "";
  const entry: LiveEntry = {
    workdir: mkdtempSync(join(tmpdir(), `sb-smoke-${name.replace("@", "-")}-`)),
  };
  live.add(entry);
  let stderrText: Promise<string> | undefined;
  try {
    // "<example>@<date>" is that example built at another compatibility date, from a
    // copy in its own temp dir so its build output never meets the plain example's.
    const [example, compatDate] = name.split("@");
    const source = example.startsWith("worker-")
      ? join(HERE, "workers-verbatim", example.slice(7))
      : join(HERE, example);
    const dir = compatDate ? join(entry.workdir, "project") : source;
    if (compatDate) cpSync(source, dir, { recursive: true, filter: (path) => !path.includes("/.sproutboat") });
    const parsed = parseConfig(readFileSync(join(dir, "sproutboat.jsonc"), "utf8"));
    if (!parsed.ok) throw new Error(`bad config: ${parsed.errors.join("; ")}`);
    const config = compatDate ? { ...parsed.value, compatibility_date: compatDate } : parsed.value;

    const sourcePath = join(dir, config.main);
    const bundle = await bundleHandler(sourcePath, dir);
    const built = await buildStandalone({
      projectDir: dir,
      config,
      sourcePath,
      source: bundle.code,
      target: "host",
      outPath: join(entry.workdir, name),
    });
    size = `${(built.bytes / 1_000_000).toFixed(1)} MB, built in ${seconds(performance.now() - started)}`;

    const port = freePort();
    const child = Bun.spawn([built.outPath], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...EXTRA_ENV[name], PORT: String(port), SB_DATA_DIR: join(entry.workdir, "data") },
    });
    entry.child = child;
    // Drained as it arrives: an undrained pipe blocks a chatty server.
    stderrText = new Response(child.stderr).text();
    const base = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + 20_000;
    let up = false;
    while (Date.now() < deadline && !up && child.exitCode === null) {
      try {
        await fetch(base + "/", { signal: AbortSignal.timeout(2000) });
        up = true;
      } catch {
        await Bun.sleep(100);
      }
    }

    if (!up) {
      lines.push(
        child.exitCode === null ? `  FAIL  never listened on ${port}` : `  FAIL  exited with ${child.exitCode}`,
      );
      failed++;
    } else {
      await EXAMPLES[name](base, (check, cond, detail) => {
        if (cond) lines.push("  ok    " + check);
        else {
          lines.push(`  FAIL  ${check}${detail === undefined ? "" : ": " + JSON.stringify(detail)}`);
          failed++;
        }
      });
    }
  } catch (error) {
    // A build error or a check that threw: the whole message, which for a
    // failed compile carries Porffor's own output.
    lines.push(`  FAIL  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    failed++;
  } finally {
    if (entry.child) {
      if (entry.child.exitCode === null) entry.child.kill(9);
      await entry.child.exited;
    }
    if (stderrText) stderr = await stderrText;
    rmSync(entry.workdir, { recursive: true, force: true });
    live.delete(entry);
  }

  const ms = performance.now() - started;
  let report = `\n${name}  (${size ? size + ", " : ""}${seconds(ms)} total)\n${lines.join("\n")}`;
  if (failed > 0 && stderr.trim()) {
    report += `\n  --- ${name} stderr ---\n${stderr.trimEnd()}\n  --- end of ${name} stderr ---`;
  }
  return { name, failed, ms, report };
}

const runStarted = performance.now();
console.log(`${names.length} examples, ${Math.min(concurrency, names.length)} at a time`);
try {
  await warmSharedCaches();
} catch (error) {
  console.log(
    `\nFAIL  could not prepare the shared toolchain caches\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
}

const results: Result[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < names.length) {
    const name = names[next++];
    console.log(`building ${name}...`);
    const result = await runExample(name);
    results.push(result);
    // One write per example, so concurrent results never interleave.
    console.log(`${result.report}\n  [${results.length}/${names.length} done]`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));

const failedNames = names.filter((name) => results.some((r) => r.name === name && r.failed > 0));
const width = Math.max(...names.map((name) => name.length));
console.log(`\nsummary (${seconds(performance.now() - runStarted)} wall clock):`);
for (const name of names) {
  const result = results.find((r) => r.name === name)!;
  console.log(`  ${result.failed > 0 ? "FAIL" : "ok  "}  ${name.padEnd(width)}  ${seconds(result.ms).padStart(7)}`);
}
console.log(
  failedNames.length === 0
    ? `\n${names.length} examples, all green.`
    : `\n${failedNames.length} of ${names.length} examples failed: ${failedNames.join(", ")}.`,
);
process.exit(failedNames.length === 0 ? 0 : 1);
