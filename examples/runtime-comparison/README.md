# Runtime comparison fixtures

Development correctness checks for identical small HTTP apps on Node, workerd,
and a standalone Sproutboat release build. No timing here is a website claim.

Run from the CLI repository:

```sh
bun examples/runtime-comparison/run.ts
```

Node and workerd must be installed. Select exact executables with `NODE_BIN`
and `WORKERD_BIN`. `RUNTIMES=node` selects a subset for adapter development;
only the default three-runtime run establishes three-way correctness.
The command fails if any selected runtime is missing, fails to build/start,
returns incorrect status/body/content type, or times out. Each run retains
its source hashes, versions, logs, commands and probe results under `results/`.
Fresh output paths prevent a failed compile from using a previous binary.

Current corpus has 23 checks covering H0-H5: health, order validation,
HMAC-SHA256 over the raw UTF-8 body, escaped HTML, buffered bytes, and controlled upstream delays/errors.
Expected outputs are independent fixed corpus values, not responses computed
by the application under test. Node uses native HTTP and Web Crypto;
workerd uses its fetch handler; Sproutboat uses its documented `request.text()` entry point.
The installed runtime/toolchain release fails the Unicode corpus. The local
runtime and toolchain fixes pass all checks without changing expected outputs.
Use `local-runtime.ts` for those unreleased fixes; the default `run.ts` uses
installed dependencies. Both retain failed checks and exclude a failed runtime
from its pilot.
Business logic is shared. There are no external frameworks or services.

For an optional low-rate development pilot after each runtime passes:

```sh
PILOT_RPS=100 PILOT_SECONDS=5 bun examples/runtime-comparison/run.ts
```

This schedules arrivals independently of responses, retains every request's
latency and correctness, and reports dropped arrivals or errors as failures.
It uses the same host for the generator and app, one trial, and no resource
limits or CPU/memory sampling. Its percentiles are harness diagnostics, not
publication-ready performance results. Rates are capped at 1,000 requests/s
and durations at 60 seconds. The five-second request deadline includes draining
in-flight requests after arrivals stop.

`PILOT_WORKLOAD=upstream` selects the 50 ms upstream fixture. `mixed` sends
90% small orders and 10% delayed-upstream requests, with separate per-route
latency distributions. The deterministic mix sends every tenth arrival to the
upstream fixture. The upstream is a separate Node process on the same host;
its response is fixed at 4 KiB. Publishable runs need reserved upstream
resources and a separate generator.

The staged follow-up is Linux resource sampling, repeated capacity trials,
and managed platform/density tests. See the specification in the platform repository:
`../sproutboat/docs/runtime-comparison-plan.md` relative to the CLI root.
Do not treat this local correctness runner as that completed benchmark suite.

To isolate native ingress and compiler encoding:

```sh
bun examples/runtime-comparison/repro-ingress.ts
bun examples/runtime-comparison/local-runtime.ts --repro
```

The second command copies the CLI into a temporary directory and links the
sibling runtime and toolchain packages and patches an isolated compiler copy. It leaves installed dependencies untouched
and retains diagnostic results here before deleting the temporary checkout.
`--repro --verify` also runs CLI tests, both binding harnesses and examples.
To run the full comparison against the local runtime, omit `--repro` and set
`WORKERD_BIN` and pilot options as usual. Its manifest marks the runtime as an
unreleased override and hashes the actual loaded prelude, toolchain patch modules, and compiled builtin table.

## Tagged Linux comparison

From a clean CLI checkout at its exact release tag (for example `v0.12.0`),
run one command from your workstation:

```sh
examples/runtime-comparison/linux/run-tagged.sh baronunread@othello
```

The script builds the current tagged CLI fixture, copies a Linux payload to the
benchmark host, runs three randomized rounds, retrieves the raw results and
exports `benchmarks/<tag>/summary.json`, `summary.md` and `results.json.gz`.
The host must have `python3`, `taskset`, user `systemd-run`, and pinned Node and
workerd executables at `~/.local/share/sproutboat-bench/tools/{node,workerd}`.
It records their actual versions, hashes and executable sizes on every run.
The host must have two available CPUs; the app receives CPU 0 with a one-core
quota and 512 MiB memory limit, while the generator and fixed upstream use CPU 1.
Do not run two comparisons concurrently. The tagged checkout must have no
tracked edits; untracked benchmark sources are included by hash in the payload.

For a shorter harness smoke run, set `BENCH_REPEATS=1 BENCH_IDLE_SECONDS=1
BENCH_REQUESTS=20 BENCH_WARMUP_REQUESTS=2` on the remote command manually. The
exported comparison requires all three candidates to pass every corpus probe
and every measured response. Defaults use three repeats, 60 seconds of idle
sampling per candidate, and 500 requests per workload at 50 offered requests/s.
The summary is a fixed-rate, direct-app result, not a capacity ranking.


For the plain pinned Porffor comparison, acquire and verify the pristine archive identified by `src/porffor-toolchain.ts`, extract it without applying Sproutboat patches, and set `PLAIN_PORFFOR_SOURCE` to that directory (with the archive saved as `source.tgz`). Run `bun examples/runtime-comparison/linux/prepare-porffor.ts`. Transfer the resulting payload plus `linux/measure.py` and `linux/measure-porffor.py` to a private test directory next to the verified `tools` directory. Run `taskset -c 1 python3 measure-porffor.py`. The harness saves compatibility failures and times only independently validated ASCII-order responses. It uses fixed loopback ports 18081/18082, checks they are unused, and stops its processes afterward. Full-fixture and reduced-baseline measurements have different feature coverage; see FINDINGS.md before using any figures.
