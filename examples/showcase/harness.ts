#!/usr/bin/env bun
/**
 * Build both apps with the real CLI, run them, and put them through check.ts.
 *
 *   bun harness.ts            `sproutboat dev` for the page's app and for the fleet app
 *   bun harness.ts workerd    the same sources under workerd (`wrangler dev`)
 */
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { checkFleetApp, checkShowcase } from "./check";
import { withServer } from "./run-server";

const HERE = import.meta.dir;
const CLI = join(HERE, "../../src/main.ts");
const FLEET = join(HERE, "fleet-app");
await buildWebUi();

if (process.argv[2] === "workerd") {
  const wrangler = (port: number) => ["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"];
  await withServer(wrangler, HERE, checkShowcase);
  // The fleet app has no /healthz of its own: any answer means it is up.
  await withServer(wrangler, FLEET, checkFleetApp, undefined, "/__ready");
  console.log("\nworkerd: all checks passed");
} else {
  const dev = (dir: string) => (port: number) => ["bun", CLI, "dev", dir, "--port", String(port), "--no-watch"];
  await withServer(dev(HERE), HERE, checkShowcase);
  await withServer(dev(FLEET), FLEET, checkFleetApp, undefined, "/__ready");
  console.log("\nsproutboat dev: all checks passed");
}
