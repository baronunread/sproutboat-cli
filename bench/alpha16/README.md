# Alpha-16 package probes

Install these isolated, pinned dependencies with `bun install --cwd bench/alpha16`, then run `bun bench/alpha16/probe.ts` from the CLI root. The script bundles each fixture, deletes its previous output, compiles a host-native standalone binary, allocates a free port and records its HTTP results. These are exploratory package probes, not a passing test suite: a failed case is recorded and the next case continues. Generated `*-out/` directories are disposable.

`qs` exercises nested parse/stringify. tRPC exercises only an in-process server caller, not its fetch adapter or subscriptions. The two itty fixtures distinguish `Router` from `IttyRouter`: the standard Router currently fails to compile because a labelled break crosses iterator cleanup. The simpler variant exercises GET parameters, POST bodies and a 404 fallback.

The release audit in `@sproutboat/toolchain/PORFFOR_ALPHA16.md` records the observed results and remaining limitations.
