#!/usr/bin/env bun
/**
 * A/B regression check for a Porffor pin bump.
 *
 *   bun bench/pin-compare.ts --baseline <dir> --candidate <dir> [--app <path>] [--reps 3]
 *
 * <dir> is an already-patched Porffor source tree — e.g. the current
 * ~/.cache/sproutboat/porffor-<old-commit> as --baseline, and whatever
 * `ensurePorffor()` materializes for the new pin as --candidate. Both the
 * toolchain (patch application) and the CLI's own build path
 * (buildStandalone/buildArtifact) get exercised for real, via
 * SPROUTBOAT_PORFFOR_DIR, exactly as `sproutboat build` would use them.
 *
 * Two things get built and measured per pin:
 *  - examples/kitchen-sink, via harness-standalone.ts as a subprocess — the
 *    existing conformance suite (every binding) is the correctness gate.
 *  - --app (default ../../standalone-app), a real compiled sproutboat app —
 *    compile time, binary size, cold start, and an HTTP throughput smoke
 *    test against its /api/health route.
 *
 * Reps are interleaved A/B/A/B/... so thermal drift cancels; the reported
 * number is the median of per-rep candidate/baseline ratios, not absolutes.
 * This is a local pre-PR command, not a CI gate (see BENCHMARKS.md's own
 * caution about timer noise) — it only hard-fails on a conformance failure,
 * a build failure, or a binary-size regression over 2%.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { parseConfig } from "../src/config";
import { bundleHandler } from "../src/bundle";
import { buildStandalone } from "../src/standalone-build";

const HERE = import.meta.dir;
const CLI = resolve(HERE, "..");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const baseline = flag("--baseline");
const candidate = flag("--candidate");
if (!baseline || !candidate) {
  console.error(
    "usage: bun bench/pin-compare.ts --baseline <porffor-dir> --candidate <porffor-dir> [--app <path>] [--reps 3]",
  );
  process.exit(1);
}
const appDir = resolve(flag("--app") ?? resolve(CLI, "../standalone-app"));
const reps = Number(flag("--reps") ?? 3);
const httpTotal = Number(flag("--http-requests") ?? 3000);
const httpConcurrency = Number(flag("--http-concurrency") ?? 8);

type Pin = { name: "baseline" | "candidate"; dir: string };
const pins: Pin[] = [
  { name: "baseline", dir: resolve(baseline) },
  { name: "candidate", dir: resolve(candidate) },
];

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const chosen = probe.port;
  probe.stop(true);
  return chosen;
}

function listens(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      done(true);
    });
    s.on("error", () => done(false));
  });
}

/** Kitchen-sink's binding conformance suite, run against a standalone binary built under `porfforDir`. */
function runKitchenSinkConformance(porfforDir: string) {
  const t0 = performance.now();
  const result = Bun.spawnSync(["bun", join(CLI, "examples/kitchen-sink/harness-standalone.ts")], {
    cwd: CLI,
    env: { ...process.env, SPROUTBOAT_PORFFOR_DIR: porfforDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const seconds = (performance.now() - t0) / 1000;
  const output = result.stdout.toString() + result.stderr.toString();
  return { ok: result.exitCode === 0, seconds, tail: output.trim().split("\n").slice(-5).join("\n") };
}

/** Build the real app once under `porfforDir`; returns compile time and binary size. */
async function buildApp(porfforDir: string, outPath: string) {
  process.env.SPROUTBOAT_PORFFOR_DIR = porfforDir;
  const parsed = parseConfig(await Bun.file(join(appDir, "sproutboat.jsonc")).text());
  if (!parsed.ok) throw new Error(`bad app config: ${parsed.errors.join("; ")}`);
  const config = parsed.value;
  const sourcePath = resolve(appDir, config.main);
  const bundle = await bundleHandler(sourcePath, appDir);
  const t0 = performance.now();
  const built = await buildStandalone({
    projectDir: appDir,
    config,
    sourcePath,
    source: bundle.code,
    target: "host",
    outPath,
  });
  const compileSeconds = (performance.now() - t0) / 1000;
  return { outPath: built.outPath, bytes: built.bytes, compileSeconds };
}

/** Spawn `bin` once, measure time to first accepted connection. */
async function coldStart(bin: string, dataDir: string): Promise<number> {
  const port = freePort();
  const t0 = performance.now();
  const child = Bun.spawn([bin], {
    env: { ...process.env, PORT: String(port), SB_DATA_DIR: dataDir },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = t0 + 10_000;
  while (performance.now() < deadline) {
    if (await listens(port)) break;
    await Bun.sleep(1);
  }
  const total = performance.now() - t0;
  child.kill(9);
  await child.exited;
  return total;
}

/** Spawn `bin`, run bench-http.mjs against /api/health, return req/s. */
async function throughput(bin: string, dataDir: string): Promise<number> {
  const port = freePort();
  const child = Bun.spawn([bin], {
    env: { ...process.env, PORT: String(port), SB_DATA_DIR: dataDir },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (let i = 0; i < 100 && !(await listens(port)); i++) await Bun.sleep(50);
    const result = Bun.spawnSync([
      "node",
      resolve(appDir, "bench-http.mjs"),
      `http://127.0.0.1:${port}/api/health`,
      "GET",
      String(httpTotal),
      String(httpConcurrency),
    ]);
    // SAFETY: bench-http.mjs's own last line is `console.log(JSON.stringify({ ... requestsPerSecond }))`.
    const parsed = JSON.parse(result.stdout.toString()) as { requestsPerSecond: number };
    return parsed.requestsPerSecond;
  } finally {
    child.kill(9);
    await child.exited;
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`kitchen-sink conformance — baseline vs candidate\n`);
const conformance: Record<string, { ok: boolean; seconds: number; tail: string }> = {};
for (const pin of pins) {
  conformance[pin.name] = runKitchenSinkConformance(pin.dir);
  console.log(
    `  ${pin.name}: ${conformance[pin.name].ok ? "PASS" : "FAIL"} (${conformance[pin.name].seconds.toFixed(1)}s)`,
  );
  if (!conformance[pin.name].ok) console.log(conformance[pin.name].tail);
}
if (!conformance.baseline.ok || !conformance.candidate.ok) {
  console.error("\nHARD FAIL: kitchen-sink conformance regressed. Not measuring performance.");
  process.exit(1);
}

console.log(`\n${appDir} — ${reps} interleaved reps per pin\n`);
const work = mkdtempSync(join(tmpdir(), "sb-pin-compare-"));
function emptySampleSet() {
  const compileSeconds: number[] = [];
  const coldStartMs: number[] = [];
  const requestsPerSecond: number[] = [];
  return { compileSeconds, bytes: 0, coldStartMs, requestsPerSecond };
}
const samples = { baseline: emptySampleSet(), candidate: emptySampleSet() };

for (let rep = 0; rep < reps; rep++) {
  for (const pin of pins) {
    const outPath = join(work, `${pin.name}-${rep}`);
    const dataDir = join(work, `${pin.name}-${rep}.data`);
    const built = await buildApp(pin.dir, outPath);
    samples[pin.name].compileSeconds.push(built.compileSeconds);
    samples[pin.name].bytes = built.bytes;
    samples[pin.name].coldStartMs.push(await coldStart(built.outPath, dataDir));
    samples[pin.name].requestsPerSecond.push(await throughput(built.outPath, `${dataDir}-2`));
    console.log(
      `  rep ${rep + 1} ${pin.name}: compile ${built.compileSeconds.toFixed(1)}s  ` +
        `size ${(built.bytes / 1e6).toFixed(2)}MB  ` +
        `cold ${samples[pin.name].coldStartMs.at(-1)!.toFixed(1)}ms  ` +
        `${samples[pin.name].requestsPerSecond.at(-1)!.toFixed(0)} req/s`,
    );
  }
}
rmSync(work, { recursive: true, force: true });

const b = samples.baseline;
const c = samples.candidate;
const sizeRatio = c.bytes / b.bytes;
const compileRatio = median(c.compileSeconds) / median(b.compileSeconds);
const coldStartRatio = median(c.coldStartMs) / median(b.coldStartMs);
const throughputRatio = median(c.requestsPerSecond) / median(b.requestsPerSecond);

const report = {
  baseline: {
    dir: baseline,
    bytes: b.bytes,
    compileSeconds: median(b.compileSeconds),
    coldStartMs: median(b.coldStartMs),
    requestsPerSecond: median(b.requestsPerSecond),
  },
  candidate: {
    dir: candidate,
    bytes: c.bytes,
    compileSeconds: median(c.compileSeconds),
    coldStartMs: median(c.coldStartMs),
    requestsPerSecond: median(c.requestsPerSecond),
  },
  ratios: { size: sizeRatio, compile: compileRatio, coldStart: coldStartRatio, throughput: throughputRatio },
};
writeFileSync(join(CLI, "bench/pin-compare.json"), JSON.stringify(report, null, 2));

const pct = (r: number) => `${r >= 1 ? "+" : ""}${((r - 1) * 100).toFixed(1)}%`;
console.log(`\n| metric | baseline | candidate | change |`);
console.log(`| --- | ---: | ---: | ---: |`);
console.log(`| binary size | ${(b.bytes / 1e6).toFixed(2)}MB | ${(c.bytes / 1e6).toFixed(2)}MB | ${pct(sizeRatio)} |`);
console.log(
  `| compile time (median) | ${median(b.compileSeconds).toFixed(1)}s | ${median(c.compileSeconds).toFixed(1)}s | ${pct(compileRatio)} |`,
);
console.log(
  `| cold start (median) | ${median(b.coldStartMs).toFixed(1)}ms | ${median(c.coldStartMs).toFixed(1)}ms | ${pct(coldStartRatio)} |`,
);
console.log(
  `| throughput /api/health (median) | ${median(b.requestsPerSecond).toFixed(0)} req/s | ${median(c.requestsPerSecond).toFixed(0)} req/s | ${pct(throughputRatio)} |`,
);
console.log(`\nwritten: bench/pin-compare.json`);

if (sizeRatio > 1.02) {
  console.error(`\nHARD FAIL: binary size regressed ${pct(sizeRatio)} (>2%).`);
  process.exit(1);
}
if (compileRatio > 1.15 || coldStartRatio > 1.1 || throughputRatio < 0.9) {
  console.log(
    `\nFLAGGED for human review: timing delta beyond the noise threshold. Not a hard fail — see BENCHMARKS.md.`,
  );
}
