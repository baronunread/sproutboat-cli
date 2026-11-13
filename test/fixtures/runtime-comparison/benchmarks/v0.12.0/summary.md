# Direct app comparison: Sproutboat v0.12.0

Run: 2026-09-30T00:44:56Z. Same validated Worker-style fixture on one Linux host, 3 randomized rounds, 50 offered requests/s. This fixed-rate run does not measure maximum throughput or hosted Cloudflare Workers.

| Measure | Node | workerd | Sproutboat |
| --- | ---: | ---: | ---: |
| Correct probes per round | 23/23 | 23/23 | 23/23 |
| App artifact | 4997 bytes | 3933 bytes | 3153096 bytes |
| Runtime executable | 148011296 bytes | 134218000 bytes | included in app artifact |
| Initialized idle PSS | 67.54 MiB | 46.23 MiB | 6.41 MiB |
| Exec to first correct response | 185.06 ms | 39.15 ms | 13.55 ms |
| Order p95 at fixed load | 4.57 ms | 2.89 ms | 2.78 ms |
| Mixed p95 at fixed load | 54.33 ms | 53.52 ms | 56.87 ms |
| Order CPU per 1,000 correct responses | 2361.27 ms | 1417.0 ms | 1101.42 ms |
| Correct measured responses | 3000 | 3000 | 3000 |

App artifact sizes count the Node source plus shared logic, the workerd bundle, and the Sproutboat standalone binary. Node and workerd also require their separately listed runtime executables and possibly shared system libraries. These sizes are an inventory, not equivalent compressed deployment packages.

Idle PSS is the median of one sample per second after correctness checks. Startup includes the test gate and one verified HTTP response. The order workload sends valid roughly 1 KiB JSON; mixed traffic sends 90% orders and 10% requests to a local upstream delayed by 50 ms. Every measured response is checked. The generator and upstream share this host on another CPU, and other services remain running.

This is a direct-app fixed-rate comparison. It does not establish saturation, many-app density, public-platform overhead, or a universal latency ranking. Raw samples, cgroup accounting, source hashes, executable hashes, versions and machine details are in the JSON artifact.

Raw results SHA-256: `155e4341892929c86e8e3aa8ca8b0704d9b239550e21ada2723186ea5ce42aca`.
