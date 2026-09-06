#!/usr/bin/env bun
/**
 * End-to-end check for the kitchen-sink example: compiles the sprout for the
 * host, stands up an in-process broker (KV / D1 / R2 / queue / DO / analytics /
 * cron) plus a stub upstream, then drives every binding over HTTP.
 *
 *   bun examples/kitchen-sink/harness.ts
 *
 * This is the local stand-in for the platform: the real supervisor spawns the
 * same broker per deployment and passes SB_BROKER_PORT / SB_BROKER_TOKEN /
 * SB_SPROUT_URL to the sprout exactly as this script does.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { runConformance } from "./conformance";
import { loadPrelude, wrapNativeFetchHandler, type Bindings } from "../../src/compile";
import { parseConfig } from "../../src/config";
import { createBroker, listen } from "../../src/broker";
import { walkAssets, type AssetManifest } from "../../src/assets";
import type { JsonValue } from "../../src/json";

/**
 * A port nothing is listening on.
 *
 * Both harnesses used to pick 8000 + random, which collides often enough to
 * produce a conformance failure that looks like a real one: the suite talks to
 * whatever else answered. Bind to 0, let the OS choose, and release it.
 */
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const chosen = probe.port;
  probe.stop(true);
  return chosen;
}

const HERE = import.meta.dir;
const CLI = join(HERE, "../..");
const PORF = join(CLI, "node_modules/porffor/runtime/index.js");

const workdir = mkdtempSync(join(tmpdir(), "sb-kitchen-"));
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
function check(name: string, cond: boolean, detail?: JsonValue) {
  if (cond) {
    passed++;
    console.log("  ok  " + name);
  } else die(`${name}${detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
}

// --- config -> bindings --------------------------------------------------
const cfg = parseConfig(readFileSync(join(HERE, "sproutboat.jsonc"), "utf8"));
if (!cfg.ok) die("bad example config: " + cfg.errors.join("; "));
const c = cfg.ok ? cfg.value : null!;

// --- stub upstream for env.QUOTE_URL -----------------------------------
const QUOTES = [
  { content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { content: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { content: "Programs must be written for people to read.", author: "Harold Abelson" },
];
const upstream = Bun.serve({
  port: 0,
  fetch: () => Response.json(QUOTES[Math.floor(Date.now() / 4000) % QUOTES.length]),
});
cleanup.push(() => upstream.stop(true));
const upstreamHost = `127.0.0.1:${upstream.port}`;

const bindings: Bindings = {
  kv: c.kv_namespaces ?? [],
  secrets: c.secrets ?? [],
  outbound: [upstreamHost], // override the example's placeholder host
  d1: c.d1_databases ?? [],
  r2: c.r2_buckets ?? [],
  queues: c.queues ?? [],
  analytics: c.analytics_engine_datasets ?? [],
  do: Object.entries(c.durable_objects ?? {}).map(([binding, className]) => ({ binding, className })),
  services: c.services ?? [],
  crons: c.triggers?.crons ?? [],
  assets: c.assets?.binding ?? "",
};
const vars = { ...c.vars, QUOTE_URL: `http://${upstreamHost}/random` };

// build the Astro UI, then publish the assets dir + manifest exactly as
// `sproutboat build` would
buildWebUi();
const assetsDir = join(workdir, "assets");
const assetSrc = join(HERE, c.assets!.directory);
if (!existsSync(assetSrc)) die(`assets dir not found: ${assetSrc}`);
cpSync(assetSrc, assetsDir, { recursive: true });
const assetManifest: AssetManifest = {
  notFound: c.assets?.not_found_handling ?? "none",
  runSproutFirst: c.assets?.run_sprout_first ?? false,
  files: walkAssets(assetsDir),
};
writeFileSync(join(workdir, "assets.json"), JSON.stringify(assetManifest, null, 2));

// --- compile the sprout for the host ----------------------------------
// The prelude needs its transport spliced in; reading the file alone yields a
// module with no __sbCall (#15).
const prelude = await loadPrelude("broker");
const gen = join(workdir, "sprout.generated.js");
const bin = join(workdir, "sprout.bin");
writeFileSync(gen, wrapNativeFetchHandler(readFileSync(join(HERE, "src/index.js"), "utf8"), prelude, vars, bindings));

console.log("compiling sprout (host native)…");
const compile = Bun.spawnSync(["node", PORF, "native", gen, "-o", bin], {
  env: { ...process.env, PATH: `${join(CLI, "node_modules/.bin")}:${process.env.PATH}` },
  stdout: "pipe",
  stderr: "pipe",
});
if (compile.exitCode !== 0) die("porffor compile failed:\n" + compile.stderr.toString() + compile.stdout.toString());

// --- broker (in-process) --------------------------------------------
const TOKEN = "harness-token";
const sproutPort = freePort();
const broker = createBroker({
  db: join(workdir, "state.sqlite"),
  dataDir: join(workdir, "d1"),
  token: TOKEN,
  bindings,
  secrets: { ADMIN_TOKEN: "s3cr3t-admin" },
  sproutUrl: `http://127.0.0.1:${sproutPort}/`,
  assetsDir,
  // #48 — on a node the control plane resolves a service name to a hostname and
  // the edge routes it. There is no edge here, so point the broker at the
  // sprout directly: the path under test is shim -> broker -> Host header.
  // A service binding must reach a *different* deployment: one sprout serves
  // one turn at a time, so pointing it at this app would deadlock. The stub
  // upstream stands in for the peer; the path under test is the same
  // shim -> broker -> Host exchange either way.
  services: { PEER: "quote-service.local" },
  edgeUrl: `http://${upstreamHost}/`,
});
const brokerServer = listen(broker, "127.0.0.1", 0);
cleanup.push(() => {
  brokerServer.stop();
  broker.close();
});

// --- sprout process -----------------------------------------------
const sprout = Bun.spawn([bin], {
  env: { ...process.env, PORT: String(sproutPort), SB_BROKER_PORT: String(brokerServer.port), SB_BROKER_TOKEN: TOKEN },
  stdout: "inherit",
  stderr: "inherit",
});
cleanup.push(() => sprout.kill(9));

const base = `http://127.0.0.1:${sproutPort}`;
async function up() {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + "/");
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  die("sprout never listened");
}
await up();

await runConformance(base, TOKEN, check);

console.log(`\n${passed} checks passed — every binding exercised end to end.`);
for (const c2 of cleanup.reverse())
  try {
    c2();
  } catch {}
process.exit(0);
