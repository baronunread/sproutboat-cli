#!/usr/bin/env bun
/**
 * The same kitchen-sink checks as harness.ts, against a standalone binary.
 *
 *   bun examples/kitchen-sink/harness-standalone.ts
 *
 * harness.ts drives a host sprout with an in-process broker, the shape the supervisor runs in production. This
 * drives one executable that carries the sprout, the assets and the bindings inside it. Both run `runConformance`
 * unchanged, which is the point: two backends, one definition of what the demo does.
 */
import { runStandalone } from "../lib/backends";
import { buildWebUi } from "./build-web";
import { runConformance } from "./conformance";

await runStandalone({
  dir: import.meta.dir,
  label: "kitchen-sink",
  adminToken: "s3cr3t-admin",
  prepare: buildWebUi,
  run: (context) => runConformance(context, { skipTriggers: true, skipServices: true }),
});
