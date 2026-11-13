#!/usr/bin/env bun
/**
 * The same binding conformance checks as harness.ts, against a standalone binary.
 *
 *   bun test/fixtures/conformance/harness-standalone.ts
 *
 * harness.ts drives a host sprout with an in-process broker. This drives one executable that carries the sprout, the
 * assets and the bindings inside it. Both run `runConformance` unchanged, which is the point: two backends, one
 * definition of what `env.KV.get` means.
 */
import { runStandalone } from "../lib/backends";
import { runConformance } from "./conformance";

await runStandalone({
  dir: import.meta.dir,
  label: "conformance",
  adminToken: "s3cr3t-admin",
  vars: (upstream) => ({ QUOTE_URL: `http://${upstream}/random` }),
  run: (context) => runConformance(context, { skipTriggers: true, skipServices: true }),
});
