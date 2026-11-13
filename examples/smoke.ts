#!/usr/bin/env bun
/**
 * Every small example (and each fixture that is plain Workers code), built and driven.
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
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { descendantPids, Harness, HarnessFailure } from "../test/fixtures/lib/harness";
import { applyProjectMigrations } from "../test/fixtures/lib/migrations";
import { FIXTURES_DIR, projectDir } from "../test/fixtures/lib/projects";
import { buildStandalone } from "../src/standalone-build";
import { bundleHandler } from "../src/bundle";
import { parseConfig } from "../src/config";
import { CHECKS, SECRETS, STANDALONE_SKIPS, type Check, type Context, type Ok } from "./checks";
import { prunePorfforBuilds } from "../src/compile";
import { ensurePorffor } from "../src/porffor-toolchain";
import { ensurePorfforPatched } from "../src/patch-porffor";
import { ensureUWebSocketsHost, UwsUnavailableError } from "../src/toolchain";
import { ensureSqliteObject } from "../src/sqlite";
import { ensureBearssl } from "../src/bearssl";

// #276: each example's requests go through its own Harness (found by origin),
// so every one has a deadline (SB_HARNESS_REQUEST_TIMEOUT_MS, default 30 s),
// names its step before it starts, and ends early if the child exits.
const harnessByOrigin = new Map<string, Harness>();
const fetch = (url: string, init?: RequestInit) => {
  const harness = harnessByOrigin.get(new URL(url).origin);
  if (!harness) return globalThis.fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  harness.step(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
  return harness.fetch(url, init);
};

const text = async (url: string, init?: RequestInit) => (await fetch(url, init)).text();

const context: Context = { fetch, text, runtime: "standalone" };

// The examples share their requests with the workerd run (checks.ts). What is here is only for the verbatim and contract
// fixtures, which are not examples. Each check is handed the runner's own request functions.
type Verbatim = (base: string, ok: Ok) => Promise<void>;
const FIXTURES = {
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
} satisfies Record<string, Verbatim>;

const EXAMPLES = {
  ...CHECKS,
  ...Object.fromEntries(
    Object.entries(FIXTURES).map(([name, check]) => [name, (base: string, ok: Ok) => check(base, ok)]),
  ),
  // The d1 example rebuilt at 2026-10-27, the earliest date where every form it uses is the standard one (D1 returns Promises
  // from 2026-10-24, request bodies and request.json() from 2026-10-27): it catches an example that only works at the
  // date its own config names. Before 2026-10-27 request.json() is synchronous, so `.catch()` on it is a TypeError.
  "d1@2026-10-27": CHECKS.d1,
} satisfies Record<string, Check>;

// Everything else spawns with just PORT/SB_DATA_DIR; vars-secrets also needs
// its one declared secret, which a standalone binary reads from the process
// environment rather than anything sproutboat.jsonc can supply.
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

const wanted = process.argv.slice(2);
for (const name of wanted) if (!isName(name)) throw new Error(`no such example: ${name}`);
const names: Name[] = wanted.length
  ? wanted.filter(isName)
  : Object.keys(EXAMPLES)
      .filter(isName)
      .filter((name) => !STANDALONE_SKIPS.has(name));

const rawConcurrency = process.env.SMOKE_CONCURRENCY ?? "4";
const concurrency = Number(rawConcurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error(`SMOKE_CONCURRENCY must be a positive integer, got "${rawConcurrency}"`);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

// Live children and temp dirs, so an interrupted run does not leave servers
// listening or temp dirs behind.
type LiveEntry = { harness: Harness };
const live = new Set<LiveEntry>();
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    // Every live example's child and temp dir, then anything they or a build
    // started (found by parent pid, never by name).
    for (const entry of live) entry.harness.cleanupSync({ descendants: false });
    for (const pid of descendantPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
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
  const harness = new Harness({
    backend: `smoke:${name}`,
    prefix: `sb-smoke-${name.replace(/[@/]/g, "-")}-`,
    secrets: Object.values(SECRETS.get(name) ?? {}),
    handleSignals: false,
  });
  const entry: LiveEntry = { harness };
  live.add(entry);
  const workdir = harness.workdir;
  let failureReport = "";
  let origin = "";
  try {
    // "<example>@<date>" is that example built at another compatibility date, from a
    // copy in its own temp dir so its build output never meets the plain example's.
    const [example, compatDate] = name.split("@");
    const source = example.startsWith("worker-")
      ? join(FIXTURES_DIR, "workers-verbatim", example.slice(7))
      : example === "workers-contract"
        ? join(FIXTURES_DIR, example)
        : projectDir(example);
    const dir = compatDate ? join(workdir, "project") : source;
    if (compatDate) cpSync(source, dir, { recursive: true, filter: (path) => !path.includes("/.sproutboat") });
    const parsed = parseConfig(readFileSync(join(dir, "sproutboat.jsonc"), "utf8"));
    if (!parsed.ok) throw new Error(`bad config: ${parsed.errors.join("; ")}`);
    const config = compatDate ? { ...parsed.value, compatibility_date: compatDate } : parsed.value;

    const sourcePath = join(dir, config.main);
    // Compilation has its own deadline (SB_HARNESS_BUILD_TIMEOUT_MS), so a slow
    // build cannot look like a hung handler.
    const built = await harness.build(`building ${name}`, async () => {
      const bundle = await bundleHandler(sourcePath, dir);
      return buildStandalone({
        projectDir: dir,
        config,
        sourcePath,
        source: bundle.code,
        target: "host",
        outPath: join(workdir, name),
      });
    });
    size = `${(built.bytes / 1_000_000).toFixed(1)} MB, built in ${seconds(performance.now() - started)}`;

    // A starter whose schema is a migration (templates/api-d1) has it applied to the binary's data directory first.
    await applyProjectMigrations(dir, config, join(workdir, "data"));
    const port = freePort();
    harness.spawn("standalone binary", [built.outPath], {
      env: { ...process.env, ...SECRETS.get(name), PORT: String(port), SB_DATA_DIR: join(workdir, "data") },
    });
    const base = `http://127.0.0.1:${port}`;
    origin = new URL(base).origin;
    harnessByOrigin.set(origin, harness);

    // Readiness has its own deadline (SB_HARNESS_READY_TIMEOUT_MS).
    await harness.waitReady(base + "/");
    harness.step(`checks for ${name}`);
    await EXAMPLES[name](
      base,
      (check, cond, detail) => {
        if (cond) lines.push("  ok    " + check);
        else {
          lines.push(`  FAIL  ${check}${detail === undefined ? "" : ": " + JSON.stringify(detail)}`);
          failed++;
        }
      },
      context,
    );
  } catch (error) {
    if (error instanceof HarnessFailure) {
      // A stall, a child that exited, or a deadline: step, backend, versions
      // and the child's recent stderr, secrets removed.
      failureReport = harness.report(error);
      lines.push(`  FAIL  ${error.message}`);
    } else {
      // A build error or a check that threw: the whole message, which for a
      // failed compile carries Porffor's own output.
      lines.push(`  FAIL  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    failed++;
  } finally {
    await harness.cleanup({ descendants: false });
    if (origin) harnessByOrigin.delete(origin);
    live.delete(entry);
  }

  const ms = performance.now() - started;
  let report = `\n${name}  (${size ? size + ", " : ""}${seconds(ms)} total)\n${lines.join("\n")}`;
  if (failureReport) report += `\n${failureReport.replace(/^/gm, "  ")}`;
  else if (failed > 0) {
    const stderr = harness.recentStderr();
    if (stderr) report += `\n${stderr.replace(/^/gm, "  ")}`;
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
