# Direct app comparison: Sproutboat v0.18.0

Run: 2026-10-20T12:48:58Z. Same validated Worker-style fixture on one Linux host, 3 randomized rounds, 50 offered requests/s. This fixed-rate run does not measure maximum throughput or hosted Cloudflare Workers.

| Measure | Node | workerd | Sproutboat |
| --- | ---: | ---: | ---: |
| Correct probes per round | 23/23 | 23/23 | 23/23 |
| App artifact | 4997 bytes | 3933 bytes | 4822384 bytes |
| Runtime executable | 148011296 bytes | 134218000 bytes | included in app artifact |
| Initialized idle PSS | 52.3 MiB | 46.54 MiB | 7.44 MiB |
| Exec to first correct response | 247.7 ms | 53.62 ms | 12.0 ms |
| Order p95 at fixed load | 5.51 ms | 5.29 ms | 2.58 ms |
| Mixed p95 at fixed load | 55.2 ms | 53.65 ms | 56.81 ms |
| Order CPU per 1,000 correct responses | 2584.73 ms | 1653.95 ms | 1158.52 ms |
| Correct measured responses | 3000 | 3000 | 3000 |

App artifact sizes count the Node source plus shared logic, the workerd bundle, and the Sproutboat standalone binary. Node and workerd also require their separately listed runtime executables and possibly shared system libraries. These sizes are an inventory, not equivalent compressed deployment packages.

Idle PSS is the median of one sample per second after correctness checks. Startup includes the test gate and one verified HTTP response. The order workload sends valid roughly 1 KiB JSON; mixed traffic sends 90% orders and 10% requests to a local upstream delayed by 50 ms. Every measured response is checked. The generator and upstream share this host on another CPU, and other services remain running.

This is a direct-app fixed-rate comparison. It does not establish saturation, many-app density, public-platform overhead, or a universal latency ranking. Raw samples, cgroup accounting, source hashes, executable hashes, versions and machine details are in the JSON artifact.

Raw results SHA-256: `f4feaf1e7cf432f6fbc62bf187432320047ceb6863558b5b4681e0a46b4cdeb0`.
