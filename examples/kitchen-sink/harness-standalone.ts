#!/usr/bin/env bun
/**
 * The same conformance checks as `harness.ts`, against a standalone binary.
 *
 *   bun examples/kitchen-sink/harness-standalone.ts
 *
 * harness.ts drives a host sprout with an in-process broker — the shape the
 * supervisor runs in production. This drives one executable that carries the
 * sprout, the assets and the bindings inside it. Both run `runConformance`
 * unchanged, which is the point: two backends, one definition of what
 * `env.KV.get` means.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { runConformance } from "./conformance";
import { buildStandalone } from "../../src/standalone-build";
import { bundleHandler } from "../../src/bundle";
import { parseConfig } from "../../src/config";
import type { JsonValue } from "../../src/json";

const HERE = import.meta.dir;
const workdir = mkdtempSync(join(tmpdir(), "sb-standalone-"));
const cleanup: Array<() => void> = [() => rmSync(workdir, { recursive: true, force: true })];
const die = (m: string) => {
  console.error("FAIL:", m);
  for (const c of cleanup.reverse())
    try {
      c();
    } catch {}
  process.exit(1);
};
let passed = 0;
const check = (name: string, cond: boolean, detail?: JsonValue) => {
  if (cond) {
    passed++;
    console.log("  ok  " + name);
  } else die(`${name}${detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
};

const parsed = parseConfig(readFileSync(join(HERE, "sproutboat.jsonc"), "utf8"));
if (!parsed.ok) die("bad example config: " + parsed.errors.join("; "));
const config = parsed.ok ? parsed.value : null!;

// The example points env.QUOTE_URL at a placeholder host; stand up a stub and
// rewrite both the var and the allowlist, exactly as harness.ts does.
const QUOTES = [{ content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" }];
const upstream = Bun.serve({ port: 0, fetch: () => Response.json(QUOTES[0]) });
cleanup.push(() => upstream.stop(true));
const upstreamHost = `127.0.0.1:${upstream.port}`;
config.outbound = [upstreamHost];
config.vars = { ...config.vars, QUOTE_URL: `http://${upstreamHost}/random` };

buildWebUi();
const sourcePath = join(HERE, config.main);
const bundle = await bundleHandler(sourcePath, HERE);

console.log("building the standalone binary…");
const built = await buildStandalone({
  projectDir: HERE,
  config,
  sourcePath,
  source: bundle.code,
  target: "host",
  outPath: join(workdir, "kitchen-sink"),
});
console.log(`  ${(built.bytes / 1_000_000).toFixed(1)} MB\n`);

// Unused by the binary (it accepts no external triggers); the suite still wants
// a value for the checks it skips.
const TOKEN = "harness-token";
const port = 8000 + Math.floor(Math.random() * 1000);
const dataDir = join(workdir, "data");
// Environment only: a native-fetch binary never sees argv (Porffor's runtime
// init calls porf_init(0, NULL)), so PORT and SB_DATA_DIR are the whole surface.
const child = Bun.spawn([built.outPath], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), SB_DATA_DIR: dataDir, ADMIN_TOKEN: "s3cr3t-admin" },
});
cleanup.push(() => child.kill(9));

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 20_000;
let up = false;
while (Date.now() < deadline && !up) {
  try {
    // AbortSignal matters: without it a binary that accepts the connection and
    // never answers hangs this loop past its own deadline.
    await fetch(base + "/", { signal: AbortSignal.timeout(2000) });
    up = true;
  } catch {
    await Bun.sleep(100);
  }
}
if (!up) die(`standalone binary never listened on ${port}:\n${await new Response(child.stderr).text()}`);

console.log("bindings (standalone):");
// The binary drives its own cron and queue timers and refuses external
// triggers, so the suite's HTTP-delivered ones do not apply here.
await runConformance(base, TOKEN, check, { skipTriggers: true });

console.log(`\n${passed} checks passed — same suite as harness.ts, one binary.`);
for (const c of cleanup.reverse())
  try {
    c();
  } catch {}
process.exit(0);
