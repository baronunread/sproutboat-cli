# First comparison: correctness before timing

Measured 2026-09-27 on macOS arm64. This is a development comparison, not a
Linux capacity measurement or a website speed claim.

| Implementation | Version | Correct probes | Local pilot |
| --- | --- | --- | --- |
| Node | 26.5.1 | 17/17 | 500/500 correct, no dropped arrivals or errors |
| workerd | 2026-09-27 (npm 1.20260927.1) | 17/17 | 500/500 correct, no dropped arrivals or errors |
| Sproutboat standalone | CLI 0.11.13, runtime 0.12.1, toolchain 0.4.13, wire 0.9.1 | 15/17 | Skipped: correctness gate failed |

The pilot offered 100 requests/s for five seconds to the small valid ASCII
order fixture. It is a harness sanity check with the generator on the same
machine as the server, not a sustainable-capacity test. No comparative latency
ranking is published here.

## UTF-8 mismatch

The order fixture sends a roughly 16 KiB JSON body whose ID is `caffè-🚤`.
The shared app uses identical order validation and JSON serialization on all
three implementations. Node and workerd return:

```json
{"id":"caffè-🚤","count":1,"total":126}
```

Sproutboat returns status 200 and correct numeric fields, but the ID contains
mojibake. A second probe authenticates the same raw UTF-8 body with HMAC-SHA256
and a test-only key. Node and workerd accept the valid signature; Sproutboat
returns `401` with `{"error":"signature"}`. The ASCII signed order passes.

Reading native `request.body` directly and then trying the documented
`request.text()` both retained the mismatch. An explicit raw-body conversion
through `TextDecoder` also failed the corpus. The committed adapter uses
`request.text()`; no custom decoder or removed Unicode fixture is used to
claim equivalence. These observations do not isolate the underlying compiler
or runtime defect. A small native ingress/encoding repro is the next step.

## Reproduce

From the CLI root, with Node and workerd installed:

```sh
WORKERD_BIN=/path/to/workerd PILOT_RPS=100 PILOT_SECONDS=5 bun examples/runtime-comparison/run.ts
```

The expected current overall exit status is 1 because Sproutboat fails two
probes. Every runtime has logs and probe results in the result directory.
The manifest includes response previews for failures, versions, source hashes,
commands, and all pilot samples. Missing runtimes also fail, rather than
silently producing a partial comparison.

The retained final local run is
`results/2026-09-27T12-15-22-867Z/manifest.json`. Results and native artifacts
are ignored by Git; this finding is the durable summary. Publication-grade
results still require the Linux protocol in the platform specification.

## Verification

- CLI unit suite: 102 passed, 0 failed.
- Broker binding conformance: 28 checks passed.
- Standalone binding conformance: 30 checks passed.
- Example smoke suite: 12 examples passed.
- Comparison code: targeted TypeScript check, Oxlint and formatting passed.
- Comparison corpus: the two failures above are retained and block Sproutboat
  performance timing for this fixture.

## Next experiments

First isolate the UTF-8 mismatch and rerun the unchanged corpus after a fix.
Then add the controlled upstream-delay fixture and move the load generator to
a separate host for repeated Linux trials, including process/cgroup memory,
CPU and equal resource budgets. Managed brokers and multi-app density remain
separate experiments. No website numbers have been changed by this work.

## Follow-up: native ingress reduction

The local runtime patch now decodes request text lazily while preserving raw
body bytes. The minimal compiled repro verifies numeric UTF-16 code units
against Bun for ASCII, `caffè`, `🚤`, and their combination. All four match
with the patch. The installed runtime retains the original ingress mismatch.

Two separate pinned-compiler limits remain. Its JSON implementation uses byte
buffers for parsed and serialized strings, and its native TextEncoder emits
surrogate halves separately. For 🚤 the encoder emits six bytes
`ed a0 bd ed ba a4` instead of UTF-8's four bytes `f0 9f 9a a4`.
The unchanged full comparison still fails the Unicode order and valid
signature on the patched runtime, so its pilot remains excluded.

The local patch is unreleased. Its manifest records the real prelude path/hash
and the override's source hashes. The compiler findings and exact pin are
written up in the platform repository at
`patches/upstream/native-unicode-json.md`; no upstream issue was filed.

## Follow-up: Unicode fixes and upstream fixture

The local runtime and toolchain now pass the original unchanged 17 probes.
The compiler patch adds UTF-16 JSON buffers, scalar UTF-8 encoding in
TextEncoder and native responses, well-formed lone-surrogate serialization,
and bounded encodeInto behavior. The CLI build cache hashes all toolchain
implementation modules so an edit cannot reuse a binary with old semantics.
The isolated runner records these as unreleased overrides and keeps the
installed dependencies and cached compiler unchanged.

Six additional upstream probes bring the corpus to 23 checks: a fixed 4 KiB
response after 0, 10, 50 or 200 ms, an upstream failure, and an invalid delay.
Node, workerd and the patched native app each passed 23/23. The upstream runs
as a separate Node process, and workerd/Sproutboat explicitly allow only its
loopback destination. There are no external API dependencies.

Verification of these local fixes passed 147 package tests, 102 CLI tests,
28 broker conformance checks, 30 standalone checks, and all 12 examples.
Native vectors cover nested/escaped Unicode JSON, quoted keys, lone surrogates,
buffer growth, malformed input, and encodeInto boundaries. TextDecoder's
separate limitations are outside this patch's scope.

The pilot now supports pure upstream or mixed traffic. Mixed traffic schedules
90% small orders and 10% 50 ms upstream requests and reports latency separately.
One local run detected a missed generator arrival while other compilation
checks were running; it was retained as a failed pilot with no server response
errors. This is why cohosted development results are not used for rankings.
Linux capacity and density remain unmeasured; bounded Linux resource and repeated traffic measurements follow below.


## Linux shared-host pilot, 2026-09-27

Shared-host bounded Linux pilot; connection per request; no saturation conclusion

| Runtime | Checks per round | Idle PSS median, MiB | Exec-to-ready median, ms | Order p95 median, ms | Mixed p95 median, ms | Correct traffic responses |
|---|---:|---:|---:|---:|---:|---:|
| node | 23/23, 23/23, 23/23 | 66.91 | 236.98 | 4.73 | 54.85 | 3000/3000 |
| workerd | 23/23, 23/23, 23/23 | 45.81 | 49.28 | 3.6 | 53.56 | 3000/3000 |
| sproutboat | 23/23, 23/23, 23/23 | 6.41 | 13.7 | 3.61 | 56.43 | 3000/3000 |

Three randomized rounds, seed 20260927. Each candidate: CPU affinity 0, CPUQuota=100%, MemoryMax=512M. Generator and fixed upstream use CPU 1. The host has two CPUs, approximately 4 GiB RAM, and existing live services. Each workload has 100 paced warmup requests then 500 arrivals at 50/s over 10 seconds. Mixed traffic is 90% orders and 10% upstream requests with a fixed 50 ms delay. Each request opens a fresh connection. Every response is checked.

PSS is a one-second idle snapshot after correctness, not a baseline before any requests. Startup includes gate exec overhead, one HTTP check, and readiness polling. Aggregate mixed percentiles include the deliberate upstream delay. Cgroup peak memory and CPU accounting cover correctness, warmup, and measured traffic. These results cannot establish maximum throughput, production cold starts, density, or hosted Cloudflare Workers performance. Sproutboat uses unreleased local Unicode fixes.

Raw results: `results/linux-payload-1790513768557/results.json` (local, ignored artifact). Runtime archive integrity, native binary/compiler hashes, machine state, response validation and individual samples are recorded there.

The recorded CPU quotas and memory limits matched the requested values in all nine cgroups. None recorded CPU throttling. PSS includes shared page proportions; cgroup memory uses kernel page ownership and should not be compared directly to PSS. Existing services were left running. Maximum throughput, multi-app density, and deployment-track comparison still require separate runs.

## Plain Porffor at the same compiler pin, 2026-09-27

The plain baseline uses pristine Porffor commit `de4eb588264885b3a1596f75010e371a2052033f`, downloaded from the pinned archive and verified against SHA-256 `1a62187a93356b36cb6ac703ce9770c8917e4fa65545fd7c33ee8a180ae5a4c9`. No Sproutboat prelude, bindings, Unicode fixes, or compiler compatibility patches are applied. Its only source change restricts the native listener to loopback. Porffor's own native-fetch bootstrap supplies Request, Response and its event loop. Listener port 18082 is configured through the handler's supported `port` property. Both binaries use the same native release compilation flags, static musl target and uWebSockets dependency cache as the Sproutboat pilot.

Two binaries were tested. The full adapter calls the identical shared fixture dispatch function. The subset retains the exact order function and reply helper, implements health and method routing, and explicitly returns 501 for other routes. It removes the signed, page, byte and upstream handlers; its smaller footprint therefore cannot be treated as an overhead measurement for an equivalent full application.

| Candidate | Rounds | Idle PSS, MiB | Exec-to-ready, ms | ASCII order p95, ms | Correct measured orders |
|---|---:|---:|---:|---:|---:|
| Plain Porffor, full fixture | 1 | 1.87 | 11.17 | 2.62 | 500/500 |
| Plain Porffor, health/order subset | 3 | 1.77 | 11.29 | 2.67 | 1500/1500 |
| Sproutboat, previous full-app pilot | 3 | 6.41 | 13.70 | 3.61 | 1500/1500 |

Multi-round numbers are medians, including the median of each round's p95. Both plain binaries passed the ASCII order workload with no errors or generator drops at 50 requests/s. Startup includes the same gated exec/readiness overhead as the previous pilot. Plain Porffor ran later, not interleaved with the other runtimes, on the shared host. The full plain baseline has only one round. These observations do not establish a latency ranking or maximum throughput.

The full plain app compiled successfully but passed only 6/23 correctness checks: health, small order, unsigned UTF-8 large order, malformed JSON, wrong method, and unknown route. The two cases requiring HTTP 422 produced a malformed status line (`HTTP/1.1` followed by an empty status). All four signed-order probes and all six upstream probes exceeded the five-second request deadline. Page and byte-buffer probes returned HTTP 500 with `native fetch promise rejected`. The pristine fetch globals have no `URL.searchParams`, no client fetch implementation, and only an empty crypto object; these are documented source limitations, while the precise causes of every timeout are not individually reduced here. The unsigned UTF-8 echo passed this external corpus; this result is not proof of correct internal UTF-16 string or encoding semantics.

The subset passed 5 of its 7 relevant health/order checks in every round, failing the same two HTTP 422 cases. Its remaining 16 routes deliberately return 501 and are excluded features, not discovered Porffor defects. We still measured the validated success-path ASCII order endpoint, and its failures remain visible beside those performance samples.

Raw results and compiler logs are retained locally in `results/plain-porffor-1790514342829/`, including `plain-results.json`, `plain-manifest.json`, generated full/subset source, compiler file hashes and per-request samples. This is a baseline for the compiler pin used by Sproutboat, not a claim about latest upstream Porffor. No issues were filed and no website figures were published.

Required verification after adding the baseline passed 102 CLI tests, 28 broker conformance checks, 30 standalone conformance checks, and all 12 examples. The existing three-runtime local correctness/pilot runner also passed. Both pristine Porffor binaries compiled and their bounded Linux order workloads were validated separately.


## Independent limitation analysis

The 2026-09-27 investigation in `sproutboat/docs/porffor-limitations-analysis.md` compares the pinned compiler with current upstream resolved to an immutable commit. It separates missing APIs from protocol errors, incorrect string/JSON/language results, fatal synchronous exceptions and unresolved async responses. The final matrix runs 45 targeted probes in three fresh processes per version, for 270 independent executions. Both versions have identical outcomes. These are targeted semantic checks, not a compatibility percentage or performance ranking.
