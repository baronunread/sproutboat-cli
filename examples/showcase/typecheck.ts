#!/usr/bin/env bun
/**
 * Typecheck the four programs here: the Worker, the fleet app, the page, and the bun scripts.
 *
 * The two apps refer to the CLI's types as "sproutboat/types", which a project finds in node_modules; here the
 * package is this repository, so this links it as examples/node_modules/sproutboat first (as ../typecheck.ts does).
 */
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const link = join(HERE, "../node_modules/sproutboat");
if (!existsSync(link)) {
  mkdirSync(join(HERE, "../node_modules"), { recursive: true });
  symlinkSync(resolve(HERE, "../.."), link);
}

let failed = false;
for (const project of [".", "fleet-app", "web", "tools.tsconfig.json"]) {
  const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", project], {
    cwd: HERE,
    stdout: "inherit",
    stderr: "inherit",
  });
  console.log(`  ${tsc.exitCode === 0 ? "ok  " : "FAIL"}  ${project}`);
  if (tsc.exitCode !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
