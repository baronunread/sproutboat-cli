#!/usr/bin/env bun
/**
 * Build the app for this machine with the real CLI, run it, and put it through check.ts.
 *
 *   bun harness.ts              `sproutboat dev` (the broker backend)
 *   bun harness.ts standalone   one binary with the bindings compiled in (no LTO: this is a check, not a release)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { runChecks } from "./check";
import { withServer } from "./run-server";

const HERE = import.meta.dir;
const CLI = join(HERE, "../../src/main.ts");
await buildWebUi();

if (process.argv[2] === "standalone") {
  const built = Bun.spawnSync(
    ["bun", CLI, "build", HERE, "-c", join(HERE, "sproutboat.standalone.jsonc"), "--standalone", "--target", "host"],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (built.exitCode !== 0) throw new Error("the standalone build failed");
  const data = mkdtempSync(join(tmpdir(), "showcase-data-"));
  try {
    const report = await withServer(
      () => [join(HERE, "dist/showcase")],
      HERE,
      (base) => runChecks(base),
      (port) => ({ PORT: String(port), SB_DATA_DIR: data }),
    );
    console.log(JSON.stringify(report.timings, null, 2));
    console.log("\nstandalone binary: all checks passed");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
} else {
  const report = await withServer(
    (port) => ["bun", CLI, "dev", HERE, "--port", String(port), "--no-watch"],
    HERE,
    (base) => runChecks(base),
  );
  console.log(JSON.stringify(report.timings, null, 2));
  console.log("\nsproutboat dev: all checks passed");
}
