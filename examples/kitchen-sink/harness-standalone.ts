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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, type HarnessError } from "../lib/harness";
import { buildWebUi } from "./build-web";
import { runConformance } from "./conformance";
import { buildStandalone } from "../../src/standalone-build";
import { bundleHandler } from "../../src/bundle";
import { parseConfig } from "../../src/config";
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
// #276: deadlines on every request, a step recorded before each one, a failure
// report with the step, backend and versions, and cleanup of this run's own
// child and temp dir on failure or interruption.
const ADMIN_TOKEN = "s3cr3t-admin";
const harness = new Harness({ backend: "standalone", prefix: "sb-standalone-", secrets: [ADMIN_TOKEN] });
const workdir = harness.workdir;
const cleanup: Array<() => void> = [];
const die = (m: HarnessError): never => {
  console.error(harness.report(m));
  for (const c of cleanup.reverse())
    try {
      c();
    } catch {}
  harness.cleanupSync();
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
// point the var at it, exactly as harness.ts does.
const QUOTES = [{ content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" }];
// /redirect: see harness.ts.
const upstream = Bun.serve({
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === "/redirect"
      ? new Response(null, { status: 302, headers: { location: "http://127.0.0.2/" } })
      : Response.json(QUOTES[0]),
});
cleanup.push(() => upstream.stop(true));
const upstreamHost = `127.0.0.1:${upstream.port}`;
// #48 — service bindings need an edge, which a standalone binary has none of;
// buildStandalone refuses them outright. Drop them here rather than keep a
// second example: the deployed path is covered by harness.ts.
delete config.services;
config.vars = { ...config.vars, QUOTE_URL: `http://${upstreamHost}/random` };

harness.step("building the web UI");
buildWebUi();
const sourcePath = join(HERE, config.main);
const bundle = await bundleHandler(sourcePath, HERE);

console.log("building the standalone binary…");
// Compilation has its own deadline (SB_HARNESS_BUILD_TIMEOUT_MS), so a slow
// build cannot look like a hung handler.
const built = await harness
  .build("compiling the standalone binary", () =>
    buildStandalone({
      projectDir: HERE,
      config,
      sourcePath,
      source: bundle.code,
      target: "host",
      outPath: join(workdir, "kitchen-sink"),
    }),
  )
  .catch(die);
console.log(`  ${(built.bytes / 1_000_000).toFixed(1)} MB\n`);

// Unused by the binary (it accepts no external triggers); the suite still wants
// a value for the checks it skips.
const TOKEN = "harness-token";
const port = freePort();
const dataDir = join(workdir, "data");
// Environment only: a native-fetch binary never sees argv (Porffor's runtime
// init calls porf_init(0, NULL)), so PORT and SB_DATA_DIR are the whole surface.
harness.spawn("standalone binary", [built.outPath], {
  // SB_EGRESS_ALLOW: the stub upstream is on loopback, which fetch() refuses (#174).
  env: {
    ...process.env,
    PORT: String(port),
    SB_DATA_DIR: dataDir,
    ADMIN_TOKEN,
    SB_EGRESS_ALLOW: "127.0.0.1",
  },
});

const base = `http://127.0.0.1:${port}`;
// Readiness has its own deadline (SB_HARNESS_READY_TIMEOUT_MS).
await harness.waitReady(base + "/").catch(die);

console.log("bindings (standalone):");
// The binary drives its own cron and queue timers and refuses external
// triggers, so the suite's HTTP-delivered ones do not apply here.
await runConformance(base, TOKEN, check, {
  skipTriggers: true,
  skipServices: true,
  upstream: `http://${upstreamHost}`,
  harness,
}).catch(die);

// baronunread/sproutboat#236: nginx proxies with HTTP/1.0 by default, which
// uWebSockets used to answer with 505. Raw socket: fetch() always speaks 1.1.
harness.step("HTTP/1.0 request over a raw socket");
const http10 = await harness.rawExchange("127.0.0.1", port, "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").catch(die);
check(
  "HTTP/1.0: answered with 200 and the connection closed",
  http10.reply.startsWith("HTTP/1.1 200") && http10.closed,
  { head: http10.reply.slice(0, 40), closed: http10.closed },
);

console.log(`\n${passed} checks passed — same suite as harness.ts, one binary.`);
for (const c of cleanup.reverse())
  try {
    c();
  } catch {}
await harness.cleanup();
process.exit(0);
