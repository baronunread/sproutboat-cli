#!/usr/bin/env bun
/** The same src/index.ts under workerd (`wrangler dev`), through the same checks. */
import { runChecks } from "./check";
import { withServer } from "./run-server";

const report = await withServer(
  (port) => ["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"],
  import.meta.dir,
  (base) => runChecks(base),
);
console.log(JSON.stringify(report, null, 2));
console.log("\nworkerd: all checks passed");
