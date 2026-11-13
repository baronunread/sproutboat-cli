#!/usr/bin/env bun
/**
 * The binding conformance checks against the broker backend: a host sprout compiled for this machine, an
 * in-process broker (KV / D1 / R2 / queue / DO / analytics / cron) and a stub upstream.
 *
 *   bun examples/conformance/harness.ts
 *
 * This is the local stand-in for the platform: the real supervisor spawns the same broker per deployment and passes
 * SB_BROKER_PORT / SB_BROKER_TOKEN / SB_SPROUT_URL to the sprout, as examples/lib/backends.ts does.
 */
import { runBroker } from "../lib/backends";
import { runConformance } from "./conformance";

await runBroker({
  dir: import.meta.dir,
  label: "conformance",
  adminToken: "s3cr3t-admin",
  vars: (upstream) => ({ QUOTE_URL: `http://${upstream}/random` }),
  run: (context) => runConformance(context, { skipDirectTransfer: true }),
});
