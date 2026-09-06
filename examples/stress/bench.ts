#!/usr/bin/env bun
/**
 * The baseline: what a standalone sprout costs and how fast it goes.
 *
 *   bun examples/stress/bench.ts            # print
 *   UPDATE_BASELINE=1 bun examples/stress/bench.ts   # rewrite BASELINE.md
 *
 * Timings run against a host build on this machine, so they measure the
 * runtime rather than a VPS — treat them as a regression signal, not a
 * capacity plan. The memory figures in BASELINE.md come from Linux, which is
 * the only place RSS means what it says (macOS keeps MADV_FREE pages resident
 * until pressure, and reports roughly twice the truth).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandalone } from "../../src/standalone-build";
import { bundleHandler } from "../../src/bundle";
import { parseConfig } from "../../src/config";

const HERE = import.meta.dir;
const work = mkdtempSync(join(tmpdir(), "sb-bench-"));
const cleanup: Array<() => void> = [() => rmSync(work, { recursive: true, force: true })];
const done = () => {
  for (const c of cleanup.reverse())
    try {
      c();
    } catch {}
};

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const chosen = probe.port;
  probe.stop(true);
  return chosen;
}

const parsed = parseConfig(readFileSync(join(HERE, "sproutboat.jsonc"), "utf8"));
if (!parsed.ok) {
  console.error(parsed.errors);
  process.exit(1);
}
const config = parsed.ok ? parsed.value : null!;

console.log("building…");
const buildStarted = Date.now();
const bundle = await bundleHandler(join(HERE, "src/index.js"), HERE);
const built = await buildStandalone({
  projectDir: HERE,
  config,
  sourcePath: join(HERE, "src/index.js"),
  source: bundle.code,
  target: "host",
  outPath: join(work, "stress"),
});
const buildMs = Date.now() - buildStarted;

/** Spawn, wait for the socket to accept, kill. Returns milliseconds. */
async function coldStart(dataDir: string): Promise<number> {
  const p = freePort();
  const t0 = performance.now();
  const proc = Bun.spawn([built.outPath], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, PORT: String(p), SB_DATA_DIR: dataDir },
  });
  let ms = 0;
  for (let i = 0; i < 20000; i++) {
    try {
      const probe = await Bun.connect({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
      probe.end();
      ms = performance.now() - t0;
      break;
    } catch {
      await Bun.sleep(0);
    }
  }
  proc.kill(9);
  await proc.exited;
  return ms;
}

// Two numbers, because they differ by an order of magnitude and both are real:
// the first exec of a freshly built binary pays for a cold page cache, every
// exec after that does not. A supervisor restarting a sprout sees the second.
console.log("measuring cold start…");
const coldFirst = Math.round(await coldStart(join(work, "cold-0")));
const warmRuns: number[] = [];
for (let i = 1; i <= 5; i++) warmRuns.push(await coldStart(join(work, `cold-${i}`)));
warmRuns.sort((a, b) => a - b);
const coldWarm = warmRuns[Math.floor(warmRuns.length / 2)];

const port = freePort();

const base = `http://127.0.0.1:${port}`;
const child = Bun.spawn([built.outPath], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), SB_DATA_DIR: join(work, "data") },
});
cleanup.push(() => child.kill(9));

for (let i = 0; i < 20000; i++) {
  try {
    const probe = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.end();
    break;
  } catch {
    await Bun.sleep(0);
  }
}
// One request before timing anything, so the throughput runs are not measuring
// the first-touch costs the cold-start numbers already cover.
await fetch(base + "/");

/** Ops per second for a route that performs `ops` binding calls per request. */
async function rate(path: string, ops: number): Promise<number> {
  await fetch(base + path); // warm
  const t0 = performance.now();
  await fetch(base + path);
  return Math.round(ops / ((performance.now() - t0) / 1000));
}

/** Requests per second and p99 for a trivial route, at a given concurrency. */
async function load(concurrency: number, total: number): Promise<{ rps: number; p50: number; p99: number }> {
  const latencies: number[] = [];
  const t0 = performance.now();
  let issued = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < total) {
        issued++;
        const s = performance.now();
        await fetch(base + "/");
        latencies.push(performance.now() - s);
      }
    }),
  );
  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    rps: Math.round(total / elapsed),
    p50: Number(latencies[Math.floor(latencies.length * 0.5)].toFixed(2)),
    p99: Number(latencies[Math.floor(latencies.length * 0.99)].toFixed(2)),
  };
}

console.log("measuring…");
const serial = await load(1, 300);
const parallel = await load(16, 1200);
const rates = {
  kvPut: await rate("/kv/write?n=2000&size=256", 2000),
  d1Insert: await rate("/d1/write?n=2000&size=256", 2000),
  r2Put: await rate("/r2/write?n=500&size=4096", 500),
  queueSend: await rate("/queue/send?n=2000&size=128", 2000),
  doPut: await rate("/do/write?n=2000", 2000),
  aeWrite: await rate("/ae/write?n=2000&size=128", 2000),
};

const rows = [
  ["binary size", `${(built.bytes / 1_000_000).toFixed(1)} MB`],
  ["build time (host, warm caches)", `${(buildMs / 1000).toFixed(1)} s`],
  ["cold start, first exec (cold page cache)", `${coldFirst} ms`],
  ["cold start, warm (median of 5)", `${coldWarm.toFixed(1)} ms`],
  ["requests/s (1 connection)", `${serial.rps}`],
  ["requests/s (16 connections)", `${parallel.rps}`],
  ["latency p50 / p99 (16 connections)", `${parallel.p50} / ${parallel.p99} ms`],
  ["KV put/s", `${rates.kvPut.toLocaleString("en-US")}`],
  ["D1 insert/s", `${rates.d1Insert.toLocaleString("en-US")}`],
  ["R2 put/s (4 KB objects)", `${rates.r2Put.toLocaleString("en-US")}`],
  ["queue send/s", `${rates.queueSend.toLocaleString("en-US")}`],
  ["DO storage put/s", `${rates.doPut.toLocaleString("en-US")}`],
  ["analytics write/s", `${rates.aeWrite.toLocaleString("en-US")}`],
];

const table = ["| measure | value |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
console.log("\n" + table);

if (process.env.UPDATE_BASELINE) {
  const doc = readFileSync(join(HERE, "BASELINE.md"), "utf8");
  const start = doc.indexOf("<!-- bench:start -->");
  const end = doc.indexOf("<!-- bench:end -->");
  await Bun.write(
    join(HERE, "BASELINE.md"),
    doc.slice(0, start) + "<!-- bench:start -->\n" + table + "\n" + doc.slice(end),
  );
  console.log("\nBASELINE.md updated");
}
done();
process.exit(0);
