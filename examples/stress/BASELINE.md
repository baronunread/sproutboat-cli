# Standalone baseline

What a standalone sprout costs and how fast it goes, so a regression shows up as a
number instead of an opinion.

Regenerate the timings with:

```sh
UPDATE_BASELINE=1 bun examples/stress/bench.ts
```

## Timings

Measured against a host build on the machine running the benchmark, so these
track the runtime, not any particular server. Compare them with each
other; a VPS needs its own run.

The two cold-start figures differ by fifty times and both are honest: the first
exec of a freshly built binary pays for a cold page cache, and every exec after
it does not. A supervisor restarting a sprout sees the second one.

<!-- bench:start -->
| measure | value |
| --- | --- |
| binary size | 2.1 MB |
| build time (host, warm caches) | 10.2 s |
| cold start, first exec (cold page cache) | 159 ms |
| cold start, warm (median of 5) | 3.3 ms |
| requests/s (1 connection) | 19536 |
| requests/s (16 connections) | 72953 |
| latency p50 / p99 (16 connections) | 0.19 / 0.43 ms |
| KV put/s | 75,479 |
| D1 insert/s | 43,065 |
| R2 put/s (4 KB objects) | 29,405 |
| queue send/s | 23,464 |
| DO storage put/s | 54,026 |
| analytics write/s | 43,964 |
<!-- bench:end -->

## Memory

From Linux, which is the only place RSS means what it says: macOS keeps
`MADV_FREE` pages resident until something needs them and reports roughly twice
the truth. Measured in a 2 GB container, `linux/amd64`.

Every binding is flat under load. Twenty thousand operations each:

| workload | resident |
| --- | --- |
| idle | 7 MB |
| KV: 20k × 1 KB puts, then list all | 37 MB |
| D1: 20k inserts, then SELECT all rows | 42 MB |
| R2: 200 × 64 KB objects, then list | 42 MB |
| queue: 20k messages, drained | 43 MB |
| analytics: 20k points, then query | 42 MB |
| Durable Object: 20k keys, then list | 43 MB |
| static assets: repeated fetches | 43 MB |

Object size moves the number; request count does not. R2 holds an object whole,
so resident memory settles at a multiple of the largest one:

| object size | after puts | after gets |
| --- | --- | --- |
| 1 MB | 15 MB | 16 MB |
| 8 MB | 37 MB | 79 MB |

Put costs 4× the object and get 9×, and the plateau holds. The get figure is
the body existing as a string, then a `Response`, then a socket write; removing
it needs streaming responses, which Porffor lacks (CanadaHonk/porffor#349).

Concurrency does not multiply any of this. A sprout serves one turn at a time,
so simultaneous uploads queue instead of stacking:

| concurrent 8 MB uploads (stored) | resident | succeeded |
| --- | --- | --- |
| 1 | 20 MB | 1/1 |
| 5 | 37 MB | 5/5 |
| 10 | 37 MB | 10/10 |
| 20 | 53 MB | 20/20 |

Five hundred small requests at 50 concurrent leave it at 43 MB.

Note what this does *not* say: a sprout serves one turn at a time, so
concurrency buys queueing, not parallelism. Twenty simultaneous uploads all
succeed and cost little more than one, because nineteen of them are waiting.

## Ceilings

Two limits exist because the size is somebody else's choice, and both refuse
instead of absorbing them:

| limit | default | why |
| --- | --- | --- |
| `SB_REQUEST_BODY_MAX` | 1 MiB | The runtime buffers an inbound body whole before the handler runs. Raising it is a decision about this deployment's memory. |
| `SB_FETCH_MAX_BYTES` | 32 MiB | An outbound response body is chosen by the remote host. Uncapped, a 100 MB response took a sprout from 43 MB to 321 MB resident. |

Sizing rule for a box: **about 7 MB, plus 9× the largest R2 object a handler
reads.** An app serving 8 MB objects settles near 80 MB; one serving 100 KB
objects stays near 10 MB.
