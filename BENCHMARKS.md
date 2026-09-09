# CLI startup measurements

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
