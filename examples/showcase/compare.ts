#!/usr/bin/env bun
/**
 * Record the same checks against Sproutboat (`sproutboat dev`) and workerd (`wrangler dev`) into
 * data/compare-recorded.json, which the page shows in section 3 with its date, host and versions.
 *
 *   bun compare.ts
 *
 * Nothing in the file is typed by hand: it is what each run returned. Run it again to refresh it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks } from "./check";
import { sourceHash } from "./build-web";
import { withServer } from "./run-server";

const HERE = import.meta.dir;
const version = (pkg: string): string =>
  JSON.parse(readFileSync(join(HERE, "node_modules", pkg, "package.json"), "utf8")).version;
const cli: string = JSON.parse(readFileSync(join(HERE, "../../package.json"), "utf8")).version;

const sproutboat = await withServer(
  (port) => ["bun", join(HERE, "../../src/main.ts"), "dev", HERE, "--port", String(port), "--no-watch"],
  HERE,
  runChecks,
);
const workerd = await withServer(
  (port) => ["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"],
  HERE,
  runChecks,
);

const recorded = {
  recordedAt: new Date().toISOString(),
  host: `${process.platform}-${process.arch}`,
  wrangler: version("wrangler"),
  workerd: version("workerd"),
  sproutboat: `sproutboat ${cli} (sproutboat dev, broker backend)`,
  sourceSha256: sourceHash(),
  runs: { sproutboat, workerd },
};
const out = join(HERE, "data/compare-recorded.json");
await Bun.write(out, JSON.stringify(recorded, null, 2) + "\n");
// The repo checks formatting, and the file is committed.
Bun.spawnSync(["bunx", "oxfmt", out], { cwd: join(HERE, "../..") });
console.log(
  `recorded ${recorded.recordedAt}: wrangler ${recorded.wrangler}, workerd ${recorded.workerd}, source ${recorded.sourceSha256.slice(0, 12)}`,
);
