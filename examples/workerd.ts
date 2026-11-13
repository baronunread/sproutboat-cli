#!/usr/bin/env bun
/**
 * Every public example, unchanged, on workerd.
 *
 *   bun examples/workerd.ts            # all of them
 *   bun examples/workerd.ts kv d1      # just these
 *   WORKERD_CONCURRENCY=1 bun examples/workerd.ts
 *
 * An example is a standard Cloudflare Worker, and this is what holds it to that. For each one it
 *
 *   1. translates sproutboat.jsonc into a wrangler.jsonc (test/fixtures/lib/wrangler-config.ts);
 *   2. typechecks the entry against the runtime types `wrangler types` generates, with no Sproutboat declaration in
 *      the program, so an API only Sproutboat has is a type error;
 *   3. runs it under workerd with `wrangler dev` and sends it the requests in checks.ts, the same ones smoke.ts
 *      sends the standalone binary.
 *
 * What is skipped is printed at the end with its reason (WORKERD_SKIPS, WORKERD_PARTIAL_SKIPS and
 * CLOUDFLARE_TYPES_SKIPS in checks.ts). Nothing is written outside a temp dir per example, and only this process's
 * own children are stopped, found by parent pid.
 */
import { join } from "node:path";
import {
  CHECKS,
  CLOUDFLARE_TYPES_SKIPS,
  SECRETS,
  WORKERD_PARTIAL_SKIPS,
  WORKERD_SKIPS,
  type Check,
  type Context,
} from "./checks";
import { buildWebUi } from "./kitchen-sink/build-web";
import { descendantPids, Harness, HarnessFailure } from "../test/fixtures/lib/harness";
import { projectNames } from "../test/fixtures/lib/projects";
import {
  typecheckAgainstCloudflare,
  workerdCompatibilityDate,
  WRANGLER,
  stopTree,
  wranglerEnv,
  writeWranglerProject,
} from "../test/fixtures/lib/workerd";

/** Examples that need another example running beside them, by name. */
const COMPANIONS = new Map([
  ["service-bindings/caller", ["service-bindings/callee"]],
  ["kitchen-sink", ["quote-service"]],
]);

/** What an example needs built before it can run: kitchen-sink's dashboard is public/ copied to site/. */
const PREPARE = new Map([["kitchen-sink", buildWebUi]]);

const CHECKS_BY_NAME: Record<string, Check> = CHECKS;
const all = projectNames();
const wanted = process.argv.slice(2);
for (const name of wanted) if (!all.includes(name)) throw new Error(`no such example: ${name}`);
const names = wanted.length ? wanted : all;
const concurrency = Number(process.env.WORKERD_CONCURRENCY ?? "3");
if (!Number.isInteger(concurrency) || concurrency < 1)
  throw new Error("WORKERD_CONCURRENCY must be a positive integer");

const maxDate = workerdCompatibilityDate();
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

const harnessByOrigin = new Map<string, Harness>();
const fetch = (url: string, init?: RequestInit) => {
  const harness = harnessByOrigin.get(new URL(url).origin);
  if (!harness) return globalThis.fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  harness.step(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
  return harness.fetch(url, init);
};
const context: Context = { fetch, text: async (url, init) => (await fetch(url, init)).text(), runtime: "workerd" };

const live = new Set<Harness>();
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    for (const harness of live) harness.cleanupSync({ descendants: false });
    for (const pid of descendantPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    process.exit(code);
  });
}

type Result = { name: string; failed: number; ms: number; report: string };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function runExample(name: string): Promise<Result> {
  const started = performance.now();
  const lines: string[] = [];
  let failed = 0;
  const secrets = SECRETS.get(name) ?? {};
  const harness = new Harness({
    backend: `workerd:${name}`,
    prefix: `sb-workerd-${name.replaceAll("/", "-")}-`,
    secrets: Object.values(secrets),
    handleSignals: false,
    readyTimeoutMs: 120_000,
  });
  live.add(harness);
  let origin = "";
  let failureReport = "";
  let wrangler: ReturnType<Harness["spawn"]> | undefined;
  try {
    const check = CHECKS_BY_NAME[name];
    if (!check) throw new Error(`checks.ts has no checks for ${name}`);
    PREPARE.get(name)?.();
    const app = join(harness.workdir, "app");
    const config = writeWranglerProject(name, app, maxDate, secrets);

    if (CLOUDFLARE_TYPES_SKIPS.has(name)) {
      lines.push(`  skip  Cloudflare's types: ${CLOUDFLARE_TYPES_SKIPS.get(name)}`);
    } else {
      harness.step("typechecking against Cloudflare's types");
      const output = await harness.build("typechecking against Cloudflare's types", () =>
        typecheckAgainstCloudflare(name, app, config),
      );
      if (output) {
        lines.push(
          `  FAIL  does not typecheck against Cloudflare's runtime types:\n${output.replace(/^/gm, "        ")}`,
        );
        failed++;
      } else lines.push("  ok    typechecks against Cloudflare's runtime types");
    }

    const port = freePort();
    const command = [WRANGLER, "dev", "-c", config];
    for (const [at, companion] of (COMPANIONS.get(name) ?? []).entries())
      command.push("-c", writeWranglerProject(companion, join(harness.workdir, `companion-${at}`), maxDate));
    command.push(
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--local",
      "--persist-to",
      join(harness.workdir, "state"),
    );
    wrangler = harness.spawn("wrangler dev", command, { cwd: app, env: wranglerEnv(harness.workdir) });
    const base = `http://127.0.0.1:${port}`;
    origin = new URL(base).origin;
    harnessByOrigin.set(origin, harness);
    await harness.waitReady(base + "/");
    harness.step(`checks for ${name}`);
    await check(
      base,
      (what, cond, detail) => {
        if (cond) lines.push("  ok    " + what);
        else {
          lines.push(`  FAIL  ${what}${detail === undefined ? "" : ": " + JSON.stringify(detail)}`);
          failed++;
        }
      },
      context,
    );
  } catch (error) {
    if (error instanceof HarnessFailure) {
      failureReport = harness.report(error);
      lines.push(`  FAIL  ${error.message}`);
    } else lines.push(`  FAIL  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    failed++;
  } finally {
    // wrangler's whole process tree, read before it is stopped (see stopTree).
    if (wrangler) await stopTree(wrangler.pid);
    await harness.cleanup({ descendants: false });
    if (origin) harnessByOrigin.delete(origin);
    live.delete(harness);
  }
  const ms = performance.now() - started;
  let report = `\n${name}  (${seconds(ms)})\n${lines.join("\n")}`;
  if (failureReport) report += `\n${failureReport.replace(/^/gm, "  ")}`;
  else if (failed > 0) {
    const stderr = harness.recentStderr();
    if (stderr) report += `\n${stderr.replace(/^/gm, "  ")}`;
  }
  return { name, failed, ms, report };
}

const runStarted = performance.now();
const runnable = names.filter((name) => !WORKERD_SKIPS.has(name));
console.log(
  `${runnable.length} examples on workerd ${maxDate} (wrangler dev), ${Math.min(concurrency, runnable.length)} at a time`,
);

const results: Result[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < runnable.length) {
    const name = runnable[next++]!;
    const result = await runExample(name);
    results.push(result);
    console.log(`${result.report}\n  [${results.length}/${runnable.length} done]`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, runnable.length) }, worker));
// Anything a failed or interrupted example left behind: this process's own descendants only.
for (const pid of descendantPids()) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

const skipped = [
  ...names.filter((name) => WORKERD_SKIPS.has(name)).map((name) => `${name}: ${WORKERD_SKIPS.get(name)}`),
  ...runnable
    .filter((name) => WORKERD_PARTIAL_SKIPS.has(name))
    .map((name) => `${name} (some requests not sent): ${WORKERD_PARTIAL_SKIPS.get(name)}`),
  ...runnable
    .filter((name) => CLOUDFLARE_TYPES_SKIPS.has(name))
    .map((name) => `${name} (not typechecked against Cloudflare's types): ${CLOUDFLARE_TYPES_SKIPS.get(name)}`),
];
const failedNames = runnable.filter((name) => results.some((r) => r.name === name && r.failed > 0));
const width = Math.max(...runnable.map((name) => name.length));
console.log(`\nsummary (${seconds(performance.now() - runStarted)} wall clock):`);
for (const name of runnable) {
  const result = results.find((r) => r.name === name)!;
  console.log(`  ${result.failed > 0 ? "FAIL" : "ok  "}  ${name.padEnd(width)}  ${seconds(result.ms).padStart(7)}`);
}
if (skipped.length) console.log(`\nskipped, with reasons:\n${skipped.map((line) => `  - ${line}`).join("\n")}`);
console.log(
  failedNames.length === 0
    ? `\n${runnable.length} examples, all green on workerd.`
    : `\n${failedNames.length} of ${runnable.length} examples failed on workerd: ${failedNames.join(", ")}.`,
);
process.exit(failedNames.length === 0 ? 0 : 1);
