# Independent Porffor limitation probes

This is a native-fetch capability investigation, not a broad JavaScript conformance suite or performance ranking. Cases isolate protocol behavior, missing host APIs, UTF-8 ingress/egress, JSON, selected language semantics and async handler settlement. Positive controls include common statuses, BMP text encoding, an escaped BMP JSON key, closures, direct async responses, explicit await, and catching awaited rejection.

`cases.ts` contains minimal source and independently specified expectations. `bun examples/runtime-comparison/limitations/oracle.ts` checks 36 synchronous semantic expectations on Bun. Its decoded request facade deliberately does not verify the asynchronous Web Request body-method contract. Host capability names are compared separately against the declared native surface. Promise-handler expectations concern the native server's response/error behavior, not a Bun-hosted server's exact error text.

`prepare.ts` verifies the pinned and current snapshot archives against their recorded SHA-256 values and creates two unpatched compiler copies. The only compiler modification binds the native listener to loopback. It builds separate synchronous and asynchronous servers with static musl release flags, stores full source/binary/compiler hashes, and copies the test harness into an ignored results directory. No Sproutboat prelude or compatibility patches are applied.

The snapshots used on 2026-09-27 are:

- Pinned: `de4eb588264885b3a1596f75010e371a2052033f`, archive SHA-256 `1a62187a93356b36cb6ac703ce9770c8917e4fa65545fd7c33ee8a180ae5a4c9`, extracted in `/private/tmp/sb-plain-porffor`.
- Current upstream at the time of inspection: `08ac7ee1077c05da2bec18dcca15197051e87b62`, archive SHA-256 `d49ce6724efde555b4cdeea0d2610baddd4310153956c79b352d86ba9cf0f60f`, extracted in `/private/tmp/sb-porffor-current`.

Acquire each archive from `https://codeload.github.com/CanadaHonk/porffor/tar.gz/<commit>`, retain it as `source.tgz` inside its extraction directory, verify its hash, and run `bun examples/runtime-comparison/limitations/prepare.ts`. These fixed commits make the current investigation reproducible; they do not track future changes to main.

Transfer the resulting payload, excluding `pin-source`/`current-source` compiler trees, to a private Linux test directory next to the checksum-verified `tools/node` binary established by the runtime comparison. Run `taskset -c 1 python3 run.py`. It checks fixed loopback ports 18081/18082 are unused, creates one native process per probe repetition, and applies a user systemd scope with CPUQuota=100%, MemoryMax=512M and CPU affinity 0. The separate fixed upstream and generator use CPU 1. Each of 45 probes runs in three fresh processes for each compiler version, giving 270 independent request attempts. A follow-up health check distinguishes a route failure from an exited or stalled server. All candidates and the upstream stop afterward.

Run `python3 examples/runtime-comparison/limitations/report.py <payload-directory>` after retrieving `results.json`. It verifies complete coverage and creates `matrix.md`. Failures remain in the raw artifact; they are never counted as successful workload requests.

The earlier sequential prototype is retained as `results-sequential.json` in the final artifact directory. One fatal request stopped the first prototype server; later prototypes isolated cases. The final run isolates every repetition. Lone-surrogate vectors generate the surrogate at runtime with `String.fromCharCode`, avoiding accidental replacement when a source file is encoded as UTF-8. JSON serialization cases return the raw serialized response, avoiding a second serialization masking which layer failed.

See the durable analysis in `sproutboat/docs/porffor-limitations-analysis.md`. No upstream reports are filed by these scripts.
