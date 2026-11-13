#!/usr/bin/env bun
/**
 * End-to-end check for the kitchen-sink demo on the broker backend: compiles the sprout for the host, stands up an
 * in-process broker (KV / D1 / R2 / queue / DO / analytics / cron) plus a stub upstream, then drives the dashboard's
 * API, its limits and its chat room over HTTP.
 *
 *   bun examples/kitchen-sink/harness.ts
 *
 * This is the local stand-in for the platform: the real supervisor spawns the same broker per deployment and passes
 * SB_BROKER_PORT / SB_BROKER_TOKEN / SB_SPROUT_URL to the sprout, as test/fixtures/lib/backends.ts does. The binding
 * conformance checks are test/fixtures/conformance/harness.ts.
 */
import { runBroker } from "../../test/fixtures/lib/backends";
import { buildWebUi } from "./build-web";
import { runConformance } from "./conformance";

await runBroker({
  dir: import.meta.dir,
  label: "kitchen-sink",
  adminToken: "s3cr3t-admin",
  prepare: buildWebUi,
  run: (context) => runConformance(context),
});
