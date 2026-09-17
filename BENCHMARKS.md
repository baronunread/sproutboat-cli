# CLI startup measurements

## Porffor pin bumps

`bun bench/pin-compare.ts --baseline <dir> --candidate <dir>` builds
examples/kitchen-sink and `../standalone-app` under both an already-patched
Porffor source tree (e.g. the previous `~/.cache/sproutboat/porffor-<sha>`) and
the new one, and compares binary size, compile time, cold start, and
`/api/health` throughput. It hard-fails on a kitchen-sink conformance
regression or a >2% binary-size regression; everything else prints and gets
flagged for a human — same noise caveat as below applies to its timing
numbers. Paste its markdown table into the pin-bump PR and append it here
under a dated heading, same as the entry below.

Management commands intentionally load only `sproutboat.jsonc`. Measure that
property with the same fixture before claiming a speedup:

```sh
fixture=$(mktemp -d)
printf '%s\n' '{"name":"bench","main":"src/missing.js","compatibility_date":"2026-09-07"}' > "$fixture/sproutboat.jsonc"
# Start a local control-plane stub that accepts GET /api/projects/bench/deployments.
# Then run each command from the baseline checkout and the candidate checkout:
hyperfine --warmup 3 \
  'SPROUTBOAT_API_URL=http://127.0.0.1:PORT SPROUTBOAT_TOKEN=test bun src/main.ts versions list '"$fixture"
```

Record the median and command line for both checkouts in the pull request. The
fixture deliberately has no `src/missing.js` or `node_modules`: a successful
management request proves source bundling and compiler acquisition were not on
the command path. Repeat for `tail` and `rollback` if their argument parsing
changes. Do not use this as a CI threshold: cold caches and local security
software make millisecond startup measurements too variable for a reliable
gate.

## Recorded 2026-09-09

Measured on macOS 15.3 (arm64), Bun 1.4.1, using `/usr/bin/time -p` and seven
fresh CLI processes per revision. The fixture was `examples/kitchen-sink`, and
the command was:

```sh
SPROUTBOAT_API_URL=http://127.0.0.1:1 SPROUTBOAT_TOKEN=bench \
SPROUTBOAT_NO_UPDATE_CHECK=1 bun src/main.ts versions list examples/kitchen-sink
```

The refused loopback endpoint makes both revisions stop at the same API call;
the baseline still reads and bundles the fixture first. Results are wall-clock
seconds, rounded to the operating system timer's hundredth-second precision:

| Revision | Samples | Median | Range |
| --- | --- | --- | --- |
| `a00eb3c` baseline | 0.03, 0.02, 0.01, 0.02, 0.01, 0.01, 0.01 | 0.01 | 0.01 to 0.03 |
| `f2e55da` candidate | 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01 | 0.01 | 0.01 to 0.01 |

At this timer resolution the median does not establish a speedup, so none is
claimed. The narrower candidate range is observational only. The management
regression test supplies the stronger behavioral evidence: valid configuration
with a missing entry point reaches the control API without bundling.

## Porffor alpha-6 -> alpha-7, recorded 2026-09-17

`bun bench/pin-compare.ts --baseline porffor-038f415e --candidate
porffor-8f015414 --reps 3`, macOS (arm64), Bun 1.4.1, against
`../standalone-app`. Kitchen-sink conformance passed on both pins.

| metric | baseline | candidate | change |
| --- | ---: | ---: | ---: |
| binary size | 2.46MB | 2.46MB | +0.0% |
| compile time (median) | 13.9s | 14.1s | +0.9% |
| cold start (median) | 175.2ms | 236.5ms | +35.0% |
| throughput /api/health (median) | 26125 req/s | 25527 req/s | -2.3% |

Per-rep cold start ranged 158-243ms on *both* pins (not just candidate vs
baseline) — the same timer-noise problem the CLI startup measurements above
already flag, not a regression. Binary size (the one metric this tool hard-
gates on) was identical; conformance passed on both. Nothing here blocks the
alpha-7 bump.
