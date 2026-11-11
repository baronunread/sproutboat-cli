# Changelog

All notable changes to `sproutboat` (the CLI) are documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/), pre-1.0 so a minor bump can still carry
a breaking change.

Reconstructed from git history on 2026-09-03 for everything through v0.4.11;
maintained going forward by the `release` skill.

## Unreleased

### Added

- **Profiles: `--profile <name>` and `SPROUTBOAT_PROFILE`.** A profile is an endpoint, its stored credential and a default team, so one machine can hold a Community login and a Cloud login side by side and say which one a command uses. `login --profile <name>` makes one (it fixes the endpoint, so `--api-url` must match when the profile exists), `logout` and `whoami` act on the profile in use, `profile list` shows them and `profile use <name>` changes the default. `whoami` and `deploy` now start with two lines, `profile` and `endpoint`, so a deploy never goes somewhere unannounced. A profile and an endpoint that name different places (`--profile cloud --api-url <community>`, or the same pair in the environment) are an error. Precedence: `--api-url` and `--profile`, then `SPROUTBOAT_API_URL` and `SPROUTBOAT_PROFILE`, then the default profile, then `https://dash.sproutboat.com`; `--profile` beats `SPROUTBOAT_API_URL` and `--api-url` beats `SPROUTBOAT_PROFILE`.
- **Global flags with Wrangler's meanings, accepted before or after the command:** `-c, --config <file>` (the project's config file; its directory is the project), `--cwd <dir>`, `-e, --env <name>`, `--env-file <file>` (repeat it; later files override earlier ones) and `-v, --version`. `dev` and `run` still take `--env` and `--env-file` as before, now through the same parser, and `--flag=value` works. A flag a command cannot honour is refused (`deploy --env staging` exits 2 instead of deploying), a repeated single-value flag takes its last value, and everything after `--` is left alone.

- **`login` on a Sproutboat Cloud endpoint is the device-code flow (RFC 8628).** It prints a code and a link, opens the browser when it can, and stores an account API key (`CLI on <hostname>`, Developer at most) for the team you approve. `logout` revokes that key on the server and then forgets it; `whoami` shows the team, the key and its access, and exits 1 when not logged in. `--account <team>` preselects a team.
- **`deploy` to the Cloud builds from source.** It bundles the project, uploads the generated source by sha256 (skipped when the Cloud has it), asks the Cloud to build it, streams the build log (`  | ` per line), then prints `✓ Built in 4.1 s · peak memory 742 MB (cap 1200 MB)` and waits for a host to apply the generation the build wrote. Assets go up by hash first. A dropped log stream resumes from the last line and then falls back to polling; Ctrl-C cancels the build (exit 130); `--no-wait` returns once the build is accepted and prints `/v1/builds/<id>`; `--dry-run` says it would build in the Cloud. A queued build the builder is holding back shows why (for example `waiting for memory (1172 MB available, a build needs 1600 MB)`) and keeps waiting. A failed build prints its reason, its peak memory when known, and exits 1; a Cloud with builds off or no builder says so, and a 429 shows the Cloud's message. Then it prints `https://<app>.<team>.sproutboat.app`. `--module app.so` and `--sproutd` with `--generation` stay as operator paths; a team key's module upload is refused with "modules are built by the Cloud; run \`sproutboat deploy\` without --module". Logged out in a terminal it logs in first; with no terminal it fails naming `SPROUTBOAT_API_TOKEN`. Other bindings and crons in `sproutboat.jsonc` are not sent yet and the deploy warns.
- **`SPROUTBOAT_API_TOKEN` always wins over a stored login** (`SPROUTBOAT_TOKEN` stays as the older name). `SPROUTBOAT_ACCOUNT` and an `account` field in `sproutboat.jsonc` choose the team, like Wrangler's `account_id`. Several teams can be stored per endpoint.
- **The deploy target is the endpoint you are logged in to.** The CLI asks it what it is (`GET /v1/config`) and deploys the Cloud way or the Community way. There is no `--cloud` flag, since Wrangler also has one target chosen by credentials.

- **`secrets put`, `list` and `delete` work on a Sproutboat Cloud app,** by name through `/v1/apps/<app>/secrets`, independent of deploys like `wrangler secret`. An app that is not deployed says to deploy first or pass `--secrets-file` on the first deploy; a 403 names `secret:write` or `secret:list`. `secrets` takes `--api-url` and `--account`.
- **`deploy --secrets-file <file>` (Cloud)** reads a `.dev.vars` or `.env` file and merges its values into the app's secrets. A build deploy never puts them in the build spec (stored in plaintext): once the build is ready they are set with `PATCH /v1/apps/<app>/secrets` and the deploy waits for that newer generation, so on a first deploy the app is briefly live before its secrets land; it cannot be combined with `--no-wait`. A module deploy sends `secrets_patch.set` in its PUT. A deploy never replaces or wipes the app's secrets, and never reads `.dev.vars` by itself.
- **`deploy` to the Cloud sends service bindings.** Each `services` entry is resolved to the same team's Cloud app of that name (`GET /v1/apps`) and sent as a `service` binding plus a `services` id map. A callee that is not deployed, a binding to the app itself, or a `compatibility_date` before 2026-11-18 fails before anything is uploaded, with the fix named. `examples/kitchen-sink` is on 2026-11-18. Depends on the Cloud secrets contract and on service binding support in sproutd.

### Changed

- The docs link in `--help` now points to https://sproutboat.com/docs (docs.sproutboat.com redirects there).
- **`build --standalone` skips LTO unless you pass `--release`** (or set `SPROUTBOAT_RELEASE=1`). Units still compile at `-O3`; only the link changes. Cold builds are faster and the link takes about 90 MB instead of 1.1 to 1.6 GB, at some request throughput: see docs/standalone.md, "Dev and release builds", for the measured numbers. `--release` is the old `-flto -O3` build, so publish binaries with it. Release and non-release binaries have separate build-cache entries. `deploy` and non-standalone builds are unchanged.
- **The default endpoint is `https://dash.sproutboat.com`** (it was `https://dashboard.sproutboat.com`).
- **Credentials live in `~/Library/Preferences/sproutboat` on macOS,** Wrangler's choice. The old `~/.config/sproutboat/credentials.json` is still read, and the next login writes the new place. Elsewhere nothing moves.
- **`sproutboat --help` is shorter and plainer.** The tagline no longer says "on your own VPS", so it fits the Cloud and a self-hosted server alike. Each command has one short line (the detail is in `sproutboat <command> --help`), internal terms like "native-fetch sprout", "broker" and "id-less storage bindings" are gone, `delete` is under SHIP, and `kv` says it covers keys, bulk data and exports. Every command has its own emoji (`run` is 🏃, `rollback` is ⏪), and the ones that drew one cell wide now carry U+FE0F so the columns line up. A GLOBAL FLAGS section lists `-h, --help` and `-v, --version`, and the footer points to `--help` for a command's options.
- **Profiles live in a new `profiles.json`; `credentials.json` does not change.** `sproutboat init` pins the CLI in each project, so one machine often runs several versions, and every older CLI keeps reading `credentials.json` exactly as before (version 1: `activeApiUrl` plus one credential per endpoint URL). `profiles.json` next to it holds the profile names, the default profile and each profile's endpoint, and refers to the credential in `credentials.json` instead of copying it. Only a second profile on an endpoint that already has one carries its own credential in `profiles.json`; `credentials.json` then holds the credential of the profile most recently saved or switched to (`login`, `profile use`) on that endpoint. Nothing to do when you upgrade: the endpoint you were logged in to becomes the `default` profile and every other stored endpoint a profile named after its host (`dash.sproutboat.com`, `localhost-8787`). Reading changes nothing on disk; the first login, logout or `profile use` writes `profiles.json`. If you ran a pre-release build that wrote a version 2 `credentials.json`, it is converted back on first use (and `credentials.v1.json`, if present, can be deleted).

### Fixed

- **A command never ignores a flag it does not know, and a URL is never a project directory.** In 0.53.1, `sproutboat deploy --api-url https://dash.sproutboat.com` read the URL as the project directory, and `--api-url=https://…` was ignored, so the deploy went to the saved endpoint (a stored Community login, say) instead of the one named. Now every command checks its options before it runs: an unknown one stops it with exit 2 (`unknown option --dry-runn (did you mean --dry-run?)`), `--flag=value` works for every flag that takes a value, and a positional that looks like `https://…` is refused where a project directory or a name goes, with a pointer to `--api-url`, `--profile` and `SPROUTBOAT_API_URL`. `--api-url <url>` and `--api-url=<url>` now work on `deploy` and on every command that talks to a control plane (`login`, `logout`, `whoami`, `secrets`, `versions`, `rollback`, `tail`, `domains`, `delete`, the storage commands); the commands that talk to none (`init`, `check`, `types`, `dev`, `run`, `build`, `toolchain`, `profile`, `complete`) refuse it and say to use `--profile` or `SPROUTBOAT_API_URL`. Before this, `versions`, `rollback`, `tail`, `domains`, `delete` and the storage commands had no `--api-url` at all and went to the saved endpoint.
- **`init`'s help text and `SURFACE.md` now say it adds the `dev`, `deploy` and `check` scripts,** not just `dev` and `deploy`. Wording only.

## [0.53.1] - 2026-11-09

Built on `@sproutboat/runtime` 0.43.0, `@sproutboat/wire` 0.22.3 and `@sproutboat/toolchain` 0.24.2, unchanged from 0.53.0. No runtime or wire change, so there is no new compatibility date and no recompile.

### Changed

- **`init` adds `sproutboat` to the project's devDependencies and the `dev`, `deploy` and `check` scripts,** the way Cloudflare's templates do for Wrangler, so a project pins the CLI version that compiles it and `npm run deploy` works after `npm install`. The range is a caret on the running CLI's version. A missing `package.json` is created (`private`, version `0.0.0`); an existing one keeps its fields and indentation, a script with the same name is never overwritten (init prints a warning naming it), and a `sproutboat` already declared in any dependency section is left as is. An unreadable `package.json` stops init before any file is written. The next step it prints follows the project's package manager (a lockfile, then the launching tool, then npm), for example `cd hello && pnpm install && pnpm run dev` (`pnpm run`, because `pnpm deploy` is pnpm's own command).

## [0.53.0] - 2026-11-09

Built on `@sproutboat/runtime` 0.43.0, `@sproutboat/wire` 0.22.3 and `@sproutboat/toolchain` 0.24.2. The runtime change is the opt-in `SB_LOG=json` log below; without it nothing an app can observe changes, so there is no new compatibility date. Every app is recompiled on its next build, since the runtime prelude changed.

### Added

- **`sproutboat tail --file <log|->` follows a standalone binary's request and error records (#268).** Run the binary with `SB_LOG=json` (runtime 0.43.0 writes them) and `tail --file` prints the last 10 matching records, then new ones as they are written, in pretty lines or one JSON record per line (`--format json`). `--status`, `--method` and `--search` filter; `--lines` sets the snapshot size and `--no-follow` prints it and exits; `--file -` reads a pipe such as `journalctl -f -o cat`. An error follows its request's filters, and errors from background work always show. A missing file is waited for, a rotated or truncated file is reread from its start, a line over 64 KiB is skipped and counted, control characters are replaced before printing, and only known fields are written, so output stays bounded and parseable. It needs no login or network and ends with exit 0 on Ctrl-C. The existing control plane `tail` (live stream, `--format json`, filters, `--recent`, `--sprout`) is unchanged. See "Logs" in `docs/standalone.md`.
- **`sproutboat run` launches a standalone binary with its settings supplied at launch (#275).** `sproutboat run [project-dir] --env-file prod.env --port 80 --data-dir /var/lib/app` starts `dist/<name>` (or `--binary`) with an environment built from three layers, highest first: `--port` and `--data-dir`, the `--env-file` files (repeat the flag; a later file overrides an earlier one), then the inherited environment. Like `wrangler deploy`, it fails before the binary starts when a declared secret (the config's `secrets` plus `--require`) is unset or empty; `--check` validates and prints a summary without starting it. The summary names each secret and the layer it came from, never a value, nothing is written to disk, and the binary and its artifact metadata are untouched, so the identical binary moves between development and production. SIGINT, SIGTERM and SIGHUP are passed to the binary and its exit status is returned. `examples/vars-secrets` walks through it.

### Changed

- **`init` scaffolds the Workers-style handler.** New projects get compatibility date `2026-09-28` and `fetch(request, env, ctx)`, so `env` and `ctx` are available without a date bump. Existing `sproutboat.jsonc` files are never rewritten, and projects on older dates keep their behavior.
- **`sproutboat dev` takes local secrets the way Wrangler does (#275).** `.dev.vars` or the `.env` files, never both (a warning names the ignored ones); `--env <name>` selects `.dev.vars.<name>` and the `.env.<name>` files; the `.env` files layer `.env.<name>.local`, `.env.local`, `.env.<name>`, `.env`; `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` turns them off; `--env-file <file>` (repeatable, later overrides earlier) replaces the default set. The process environment is not passed to the app, except for declared secret names when `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` and no `.dev.vars` is in use, and files win over it. A declared secret with no value is a warning and `dev` still starts. Files use dotenv syntax; a line that is not an assignment is skipped with a `file:line` warning that never repeats the line.
- **`.dev.vars` is now parsed with dotenv syntax.** It used to be a simpler format. The differences that can matter: an unquoted value ends at a `#` (it used to keep it), quotes may be single, double or backtick, double quotes expand `\n`, and the last of a repeated name wins. A line that is not an assignment is skipped with a warning instead of silently.
- **`docs/standalone.md` no longer lists `<data>/secrets.json`**: a standalone binary has only ever read secrets from the environment.

### Fixed

- **The native conformance harnesses no longer hang on a stalled response (#276).** The broker and standalone kitchen-sink harnesses and the small-example smoke runner give every HTTP and raw-socket request a deadline (`SB_HARNESS_REQUEST_TIMEOUT_MS`, default 30 s) that covers the whole body, and bound readiness (`SB_HARNESS_READY_TIMEOUT_MS`) and compilation (`SB_HARNESS_BUILD_TIMEOUT_MS`) separately, so a slow build cannot look like a hung handler. A timeout, or a child that exits during a request, reports the step, backend, runtime and toolchain versions and the child's recent stderr with secret values removed. Only the run's own children are stopped and its temp dir removed, on failure and on SIGINT or SIGTERM. Fault-injection tests cover a server that never completes a body and a child that exits mid-request. This is repository tooling; the shipped CLI does not change.

## [0.52.1] - 2026-11-08

Built on `@sproutboat/toolchain` 0.24.2, `@sproutboat/runtime` 0.42.2 and `@sproutboat/wire` 0.22.2. The compiler output changes (four Porffor alpha 22 miscompile fixes in the toolchain), so every app is recompiled on its next build. Nothing else an app can observe changes, so there is no new compatibility date.

### Fixed

- **Four Porffor alpha 22 miscompiles are fixed** (toolchain 0.24.2), found with postgres.js and drizzle-orm. A method call on a receiver of unknown type evaluated its arguments in C's unspecified order, so `buf.toString("utf8", i, i += n)` returned `""`. A class declaration that is assigned to, such as TypeScript's `(SQL || (SQL = {}))` namespace merge, never stored the class in its binding and died with "Cannot get property of null". The right operand of `||`, `&&` and `??` retyped a local at compile time as if it always ran, so the same pattern inside a function still failed. `new Date(s)` returned NaN for `+HH` and `+HHmm` offsets such as Postgres' `2026-11-08 14:48:19.097+00`; they now parse, together with `+HH:mm`.
- **A warm standalone build no longer recompiles every C unit.** The alpha 22 build cleared the units directory, object cache included, before each render, so every build paid the full C compile (about 13 s for hello on an M1). It now clears only the previous render and keeps `obj/`; a unit whose text and flags are unchanged is not compiled again.
- **`build --standalone --target host` uses the compile cache.** An unchanged host build returns in about 0.2 s (was about 39 s for hello). The key includes the host compiler's name and `--version` banner. Dev builds still bypass it.

## [0.52.0] - 2026-11-06

Built on `@sproutboat/toolchain` 0.24.1, `@sproutboat/runtime` 0.42.2 and `@sproutboat/wire` 0.22.2. The compiler changes, so every app is recompiled on its next build. Nothing an app can observe changes apart from the two fixes below, so there is no new compatibility date.

### Changed

- **Standalone binaries and deploys now build with Porffor alpha 22** (was alpha 19). Binaries are about 5% smaller (hello 6.58 to 6.27 MB, stress 6.62 to 6.30 MB, linux-x64). Apps using jose, yaml, supabase-js and Neon (HTTP, and `Pool` over WebSocket) are checked route by route and give the same results as on alpha 19 and on Bun. Measured against alpha 19 on the same box: idle memory is 3 to 7% lower, requests per second are 5 to 15% lower, p50 latency is 3 to 8% higher, and p95 is up to about 30% (5 to 8 µs) higher on a request-heavy app. The module is composed the way sproutd's workers are, so no Node runtime module is linked, and it is served by the same uWebSockets server as before (WebSockets, streaming, graceful restart). LTO is on for optimized builds.
- **Fallback:** `SPROUTBOAT_PORFFOR_CHANNEL=alpha-19` builds with the previous alpha 19 compiler for this release only; it will be removed in the next one. The compile cache is keyed by channel, so switching back and forth does not reuse the wrong binary. The artifact manifest and `sproutboat versions view` now report the Porffor release a build actually used (`alpha-22 (a081ebd)`).
- **`build --standalone --with-restore` stays on alpha 19 for now.** Its offline `ltx-restore` command is built against alpha 19's native C API, which alpha 22 does not provide yet, so such a build uses the alpha 19 compiler. Setting `SPROUTBOAT_PORFFOR_CHANNEL=alpha-22` together with `--with-restore` is an error, not a link failure.

### Fixed

- **A `Uint8Array` or `ArrayBuffer` response body is sent with its real length.** On the alpha 22 server the bridge read the length from the buffer's flags word, so such a response went out with `Content-Length: 2147483647`. Found while qualifying alpha 22. No release ever shipped it, since alpha 19 was the default until now.
- **Neon's `Pool` over WebSocket no longer hangs.** Alpha 22 linked its Node runtime's `process`, `setImmediate`, `clearImmediate` and `global` for any app that named them. pg-pool then queued on `process.nextTick`, and a standalone binary never drains that queue. These four names are now absent, as on alpha 19, so libraries no longer take their Node code paths.

## [0.51.1] - 2026-11-05

Built on `@sproutboat/runtime` 0.42.2, `@sproutboat/toolchain` 0.23.1 and `@sproutboat/wire` 0.22.2. Nothing an app can observe changes except latency, the refused address ranges below and the `startTls()` write order, so there is no new compatibility date.

### Fixed

- **Bytes written right after `socket.startTls()` no longer go out unencrypted.** On a `connect()` socket, the I/O thread took the start-TLS request and the app's queued writes in the same pass, and flushed all of them in plaintext before switching to TLS. Any write queued before the thread picked up the upgrade could leave in the clear. Only the bytes written before `startTls()` now go out in plaintext. Everything after waits until the TLS engine owns the socket, and new writes on the old plaintext socket reject, as in workerd. A failed plaintext flush is now a connection error. The egress tunnel also no longer stays paused on the discarded plain socket after an upgrade under backpressure.

- The BearSSL source ships in the package (`vendor/bearssl`, 867 KB) and is read first, hash-verified, so builds no longer depend on bearssl.org being up. bearssl.org stays as the fallback, with bounded retry on 5xx. Every source, vendored or downloaded, is checked against the pinned sha256, so a bad file cannot change what gets built.
- **A malformed `connect()` tunnel opening frame no longer ends the egress process.** A `tcp.open` head whose JSON did not parse used to throw out of the egress service's socket handler before the token was checked, which took egress down for every app. It now gets an `expected tcp.open` error frame and only that connection closes; the broker answers it as a bad request, and a refused head stops buffering whatever the client keeps sending.

### Changed

- **`fetch()` and `connect()` refuse more reserved address space** that carries no public service: AS112 and the old IPv4 anycast blocks (`192.31.196.0/24`, `192.52.193.0/24`, `192.88.99.0/24`, `192.175.48.0/24`), SIIT (`::ffff:0:0:0/96`), IETF protocol assignments including Teredo (`2001::/23`), `3fff::/20` and SRv6 (`5f00::/16`). This applies to the broker, the egress service and a standalone binary alike, and `SB_EGRESS_ALLOW` still overrides it.

### Performance

- **Outbound TCP sockets set `TCP_NODELAY`.** Nagle's algorithm and the peer's delayed ACK stalled every fresh HTTPS `fetch()` by about 44 ms on Linux, because each small TLS handshake flight waited for an ACK; a fresh fetch now takes about 1.4 ms. This covers `fetch()`, outbound WebSockets and `connect()` on a standalone binary, including sockets handed over by `SB_EGRESS_FD`, and the egress tunnel's connections to origins.

## [0.51.0] - 2026-11-03

Built on `@sproutboat/runtime` 0.42.0, `@sproutboat/toolchain` 0.23.0 and `@sproutboat/wire` 0.22.0. The change below starts at a new compatibility date; earlier dates answer as before.

### Added

- **`connect()` from `cloudflare:sockets` from `2026-11-17`**: TCP sockets with `readable`, `writable`, `opened`, `closed`, `close()` and `startTls()`, on a standalone binary, under `sproutboat dev` and on a platform deploy. The same unmodified Postgres (`pg`, `postgres`) and Redis driver code that runs on workerd runs here, with no differences from workerd in the driver suites. Outbound policy is the one `fetch()` uses. Before the date, importing `cloudflare:sockets` fails the build with `cloudflare:sockets needs compatibility_date 2026-11-17 or later`.
- **From the same date a driver bundles as it does for workerd**: the `workerd` export condition (`pg-cloudflare`, `postgres/cf`), a bundled `Buffer`, `process` and `global`, and shims for `net`, `tls`, `dns`, `fs` and `crypto` so the Node branch of a driver names `cloudflare:sockets` instead of failing the build. A named function expression that shadows a global builtin function is renamed, which sproutd admission needs.

## [0.50.0] - 2026-11-02

Built on `@sproutboat/runtime` 0.41.0, `@sproutboat/toolchain` 0.22.0 and `@sproutboat/wire` 0.21.4. Each change below that an existing app could observe starts at a new compatibility date; earlier dates answer as before.

### Added

- **`fetch()` on a standalone binary runs off the event loop from `2026-11-16`**: 20 concurrent fetches to a 100 ms endpoint take about
  105 ms instead of 2,040 ms, and other requests keep being served meanwhile. Requests now interleave across `await fetch()`, as in workerd,
  which is why it starts at a new date; earlier dates answer as before.

### Changed

- **Secrets from the environment decode as UTF-8 from `2026-11-07`** on a standalone binary. Before, the handler got the environment's bytes one char per byte, so `é` arrived as `Ã©`.

### Performance

- **ES256 (ECDSA P-256) in `crypto.subtle` signs 2.2x and verifies 3.1x faster** (macOS arm64, standalone and broker: 2,563 to 5,621 signs and 1,318 to 4,050 verifies per second). BearSSL is pinned to master commit `7bea48e` instead of 0.6 (source: the bearssl.org gitweb snapshot, sha256 `ed397832…`) and the runtime selects its 64-bit P-256 code (`ec_p256_m64`) where the target has a 128-bit multiply, which includes both Linux targets. Results are unchanged, so there is no new compatibility date; every other primitive is as before.

## [0.49.0] - 2026-10-31

Built on `@sproutboat/runtime` 0.39.0, `@sproutboat/toolchain` 0.22.0 and `@sproutboat/wire` 0.21.2. Nothing an app can observe changes, so there is no new compatibility date.

### Added

- **A standalone binary restarts without dropping a request.** The listening socket is never closed by a restart: under systemd socket activation the binary serves on the socket it is given (`LISTEN_FDS`), and `kill -USR2` starts the binary now on disk as a child that inherits the socket and then drains. `SIGTERM` and `SIGINT` drain too (stop accepting, `Connection: close`, exit when idle). Tuned by `SB_DRAIN_SECONDS`, `SB_DRAIN_QUIET_MS` and `SB_EXEC_PATH`. On a 2-core box, 200 swaps under load by either route served over 100,000 requests each with none failed; the old recipe reset 134 of 283,966.
- **`build --standalone --target linux-arm64`**, and `--target linux-x64` as a name for the default, build a static musl binary for an aarch64 box from any machine. uSockets, SQLite and BearSSL are built for the target and cached.
- **`build --standalone --deploy-files`** writes a `FROM scratch` Dockerfile (6.5 MB image), a systemd socket and service, a `fly.toml` and one-command `deploy-vps.sh` and `deploy-fly.sh` scripts beside the binary.

### Changed

- The standalone docs say that several copies behind `SO_REUSEPORT` need `SB_SQLITE_EXCLUSIVE=0`, and cover restarting, targets, containers and Fly.io.

### CI

- The macOS runners moved from `macos-14` to `macos-15` ahead of the macOS 14 retirement.

## [0.48.1] - 2026-10-31

Same packages as 0.48.0 (`@sproutboat/runtime` 0.39.0, `@sproutboat/toolchain` 0.21.3, `@sproutboat/wire` 0.21.2). The v0.48.0 tag
published the four platform packages but not `sproutboat` itself, because the release job's test run timed out; 0.48.1 publishes all
five at one version.

### Fixed

- **The release test run no longer times out**: the native restore test builds two standalone binaries cold, which took 476 s on CI at
  0.47.0 and over 600 s at 0.48.0 as the prelude grew; its limit is now 1,200 s.

## [0.48.0] - 2026-10-30

Built on `@sproutboat/runtime` 0.39.0, `@sproutboat/toolchain` 0.21.3 and `@sproutboat/wire` 0.21.2. Each change below that an
existing app could observe starts at a new compatibility date; earlier dates answer as before.

### Added

- **Database clients that need only `fetch` or WebSocket build and run unmodified from `2026-11-15`** (`@libsql/client`,
  `@neondatabase/serverless`, `@supabase/supabase-js`, `@upstash/redis`, `@planetscale/database`; 113 of 117 comparisons with workerd
  match, the rest being the wording of a network error). The build check for Node, Bun and Deno globals skips a use behind a
  `typeof` test, a global the bundle declares itself, and mentions in strings and comments; `Error.captureStackTrace` exists.

### Fixed

- **`fetch()` on a standalone binary returns a promise from `2026-10-22`**, so `fetch(url).then(...)` works and a refused request
  rejects.
- **A fetched 204, 205 or 304 response** no longer throws "Response with null body status cannot have body".
- **A `Uint8Array` subclass that redefines a builtin method** (a `Buffer` polyfill's `toString("hex")`) reaches its own method.
- **A collector crash (SIGBUS)** when an object grew (toolchain 0.21.3).

## [0.47.0] - 2026-10-30

Built on `@sproutboat/runtime` 0.38.0, `@sproutboat/toolchain` 0.21.1 and `@sproutboat/wire` 0.21.1.

### Added

- **`crypto.subtle` like workerd from `2026-11-06`**: RSASSA-PKCS1-v1_5, RSA-PSS, RSA-OAEP, ECDSA (P-256, P-384, P-521), ECDH,
  Ed25519 (and `NODE-ED25519`), X25519, AES-GCM, AES-CBC, AES-CTR and AES-KW, PBKDF2 and HKDF for every hash, `generateKey`,
  `importKey` and `exportKey` in raw, spki, pkcs8 and jwk, `deriveBits`, `deriveKey`, `wrapKey`, `unwrapKey` and
  `crypto.DigestStream`, with workerd's DOMException error names. Earlier dates answer as before. The primitives are
  BearSSL's and Monocypher's, and standalone and broker builds both carry them.

### Changed

- **A build whose handler never names `subtle`, `DigestStream` or `CryptoKey` carries none of the crypto code** (its generated
  program is unchanged); a broker build whose handler does use `crypto.subtle` links the cached BearSSL library for it.

## [0.46.0] - 2026-10-30

Built on `@sproutboat/runtime` 0.37.1, `@sproutboat/toolchain` 0.21.1 and
`@sproutboat/wire` 0.21.0. Each change below that an existing app could observe starts at a new
compatibility date; earlier dates answer as before.

### Added

- **D1 like workerd from `2026-11-03`**: a PRAGMA outside D1's allow-list fails with `not authorized`,
  and `exec()` errors and empty statements follow workerd.
- **Durable Objects like workerd from `2026-11-04`**: `alarm(alarmInfo)` with `{ retryCount, isRetry }`,
  multi-statement `sql.exec()`, `ctx.storage.kv`, `ctx.abort()`, `ctx.props`, transactions on one object
  that run one after another, a transaction that refuses use after `rollback()` or commit, structured
  clone that keeps shared and circular references, and the argument checks of `get`, `put`, `list` and
  `setAlarm`.
- **Queues like workerd from `2026-11-05`**: the v8 content type keeps shared and circular references, holes
  and invalid dates, message fields are read-only, `send()` and `sendBatch()` check their arguments, and a
  delivery with non-ASCII text reaches the consumer as UTF-8 instead of mojibake.
- **`DOMException` is a constructible global**, and abort and timeout reasons are instances of it.
- **`TextDecoder` decodes UTF-16LE, UTF-16BE and windows-1252**; `Blob.prototype.stream()` exists; a
  constructed `Response` has `url` "" and `redirected` false.

### Fixed

- **`crypto.getRandomValues` fills every byte** of a wider view (a `Uint32Array` came back below 256).
- **A collector crash (SIGBUS)**: a minor collection scanned the entries block an array left behind when it
  grew, and marked blocks that had been freed and reused. A request that rejects more promises than
  Promise's pending list has room for could end the process some hundreds of requests later.

## [0.45.0] - 2026-10-29

### Added

- **`sproutboat tail` is a live tail.** It streams the app's request events, `console.*` output and uncaught
  exceptions from the control plane (`GET /api/projects/<name>/tail`, Server-Sent Events) in the shape of a
  Workers tail event. Pretty colored lines by default, one JSON event per line with `--format json`. Server-side
  filters: `--status ok|error|<code>|5xx`, `--method GET,POST`, `--sampling-rate 0.1`, `--search <text>`,
  `--outcome <name>`. It reconnects when the server's ten minute cap closes the stream, reports dropped events on
  stderr, and exits 0 on Ctrl-C. Console lines are separate events, not attached to a request (the runtime does not
  tag them with a request id).

### Changed

- **`sproutboat tail` with no flags no longer prints and exits.** The old dump of the last 100 request records is
  `sproutboat tail --recent`; `--sprout` is unchanged. Live tail needs a control plane newer than v0.12.0; against
  an older one the command says so and points at `--recent`.

## [0.44.0] - 2026-10-29

Built on `@sproutboat/runtime` 0.36.0, `@sproutboat/toolchain` 0.21.0 and
`@sproutboat/wire` 0.20.4.

### Added

- **`AsyncLocalStorage`** from `node:async_hooks`, as Workers has it: `run`, `exit`, `getStore` and the static
  `snapshot`. `enterWith` and `disable` throw, as there. The store follows a request across awaits,
  microtasks, timers, intervals, async `fetch`, WebSocket callbacks and `ctx.waitUntil`, and requests
  interleaved in one process never see each other's. The static `bind` is not provided: Porffor compiles a
  `.bind(` call on a function value to `Function.prototype.bind`, so use `snapshot()`. The import used to
  build and then throw "not a constructor" when the app ran, so there is no compatibility date for it. Cost: a
  promise reaction is 56 bytes instead of 40.

### Changed

- **`x-sb-cpu-ms` is per request when requests interleave in one process.** A request is charged the thread
  CPU time of the slices in which it ran, not the process delta across its handler, so a request is no longer
  charged for its neighbours' work. From compatibility date `2026-11-02` an async handler is stamped too
  (logs show it as `cpuMs`); earlier dates still send no stamp for an async handler. A synchronous
  handler's stamp is thread time, which leaves out the egress threads.

## [0.43.0] - 2026-10-29

Built on `@sproutboat/runtime` 0.35.0, `@sproutboat/toolchain` 0.20.1 and
`@sproutboat/wire` 0.20.3.

### Fixed

- **A collection no longer frees the entries block of Promise's pending-rejections array.** In a long-running
  native process (a standalone binary, or a worker under sproutd), the first rejections that grew that array
  past its static capacity moved its entries to the heap, and the collector then skipped the whole array as
  malformed. Every collection freed the block, and the next rejection wrote into memory that now belonged to
  another object: a string or an array of a request suspended at an `await` could change silently. A
  standalone binary showed it in about 1 fresh process in 5 under interleaved requests, with no failure
  reported anywhere. Rebuild standalone binaries to pick up the fix.

## [0.42.0] - 2026-10-28

Built on `@sproutboat/runtime` 0.35.0, `@sproutboat/toolchain` 0.20.0 and
`@sproutboat/wire` 0.20.3.

### Changed

- **A standalone binary opens its SQLite databases in EXCLUSIVE locking mode by default.** The lock is
  taken once and held, so a transaction no longer takes and releases file locks around itself (about two
  `fcntl` calls per request), and the WAL index lives in memory instead of a `-shm` file. The page cache
  stays at 2 MB; `SB_SQLITE_CACHE_MB=<n>` (1 to 4096) sizes it. **While the binary runs, no other process can
  open its databases:** the `sqlite3` shell, `sproutboat kv|d1 --local --data-dir` and several copies behind
  `SO_REUSEPORT` are locked out. Set `SB_SQLITE_EXCLUSIVE=0` to keep shared locking. Databases under LTX
  replication are never exclusive. sproutd and the broker are unchanged.

### Performance

- **A request's fixed cost drops its text round trips, regular expressions and repeated lookups**: the CPU
  stamp and the streamed-body probe return numbers, `Headers` checks names and values in C, the ingress
  header reads scan the stored names, and an empty `waitUntil` list creates no coroutine.
- **A strict D1 query in a standalone binary takes a direct lane**, with no statement closures, no regular
  expression for the transaction check and a result header built as JS values instead of JSON text.
- **No 88 KiB `mmap` and `munmap` for every statement that builds a temporary table** (`INSERT ...
  RETURNING`, sorts). On the API-challenge create endpoint that is about 930 to 700 us of CPU per request.
- **A response's plain-ASCII header names, header values and body are written straight from the heap**
  instead of through a `malloc`ed copy (standalone binaries).

## [0.41.0] - 2026-10-28

Built on `@sproutboat/runtime` 0.34.5, `@sproutboat/toolchain` 0.19.5 and
`@sproutboat/wire` 0.20.2.

### Performance

- **`JSON.stringify` returns an 8-bit string when it can**, and skips the zeroed buffer for a plain string.
  The feed endpoint of the API-challenge app goes from about 475 to 415 us of CPU per request.
- **A strict D1 row's text goes into one arena**, and ASCII text becomes a JS string in one copy
  (standalone binaries). The feed endpoint gains about 16 us per request.
- **The client address is folded once per distinct address**, not on every request.
  About 1.5% of a request.
- Together, on the API-challenge mix on one pinned x86 core, the stack holds 3,200 req/s or more at the bar
  (p95 under 500 ms, p99 under 1 s, errors under 1%) where the previous release held 2,800.

## [0.40.0] - 2026-10-28

Built on `@sproutboat/runtime` 0.34.4, `@sproutboat/toolchain` 0.19.4 and
`@sproutboat/wire` 0.20.2.

### Performance

- **A standalone binary collects garbage every 8 requests**, and once it has been quiet for about 50 ms,
  instead of after every response. On the API-challenge mix at 900 req/s the CPU per request goes from about
  550 to about 470 us, and the feed endpoint from 940 to 750 us, for about 2 MiB more resident memory.
  `SB_GC_EVERY=<n>` sets the interval (`1` restores a collection after each request). A request that needs
  more heap than is free still collects when it allocates. sproutd's collector and density are untouched.
- **JWT verification costs less CPU.** `atob` decodes in C for the usual input and falls back to the
  existing code for everything else, `TextEncoder.encode` sizes and fills the array in two C passes, the
  `ArrayBuffer` returned by `crypto.subtle.sign` and `digest` is copied with one `memcpy`, and the
  constant-time compare behind `verify` runs in C. A typical `authenticate()` goes from 21.5 to 7 us on an
  M-series host. What throws, and what it throws, is unchanged.

## [0.39.0] - 2026-10-27

Built on `@sproutboat/runtime` 0.34.3, `@sproutboat/toolchain` 0.19.3 and
`@sproutboat/wire` 0.20.2.

### Performance

- **D1 queries cost less CPU in standalone builds.** A D1 call no longer goes through `JSON.stringify` and
  `JSON.parse` on both sides of the in-process dispatch, and from compatibility date 2026-10-24 the rows of a
  strict D1 result are built as JS arrays in C straight from the SQLite cells instead of being written as JSON
  and parsed again. Same results and error messages.
- **`atob` is faster.** Each character is looked up in a 128-entry table, and the same pass validates, so a JWT
  check (three base64url decodes) costs less. Same output and same `InvalidCharacterError` cases.
- **`JSON.stringify` of strings is faster.** Each character is read straight from the string and stored when it
  needs no escape. The output is byte-identical.

## [0.38.0] - 2026-10-27

Built on `@sproutboat/runtime` 0.34.2, `@sproutboat/toolchain` 0.19.2 and
`@sproutboat/wire` 0.20.2.

### Performance

- **A request costs about a quarter of the CPU it did.** Most of it was one thing: Porffor's `globalThis`
  rebuilt the whole global object (one write per top-level binding) on every read, and a plain request
  made about eleven reads. A read of `globalThis` now rewrites only the bindings that changed, the
  runtime's own request path reads no `globalThis` at all, the client IP and trusted-proxy headers are
  read once per process, and `x-sb-cpu-ms` is added to your Response instead of building a second one.
  Measured on one pinned x86 core, a 404 from a standalone binary went from 319 to 89 microseconds of CPU
  per request when saturated (3,100 to 11,000 requests per second on that core); a small JSON 200 from
  322 to 78. `globalThis.x` in your own code is cheap too: 20,000 reads with 600 top-level functions took
  9.3 s before and a few milliseconds now. Nothing in the responses changes.

## [0.37.0] - 2026-10-27

Built on `@sproutboat/runtime` 0.34.1, `@sproutboat/toolchain` 0.19.1 and
`@sproutboat/wire` 0.20.2.

### Fixed

- **A failed binding call you do not await no longer ends the process.** An un-awaited
  `db.prepare("INSERT ...").run()` that broke a foreign key used to take the whole binary down, even
  with a `try` / `catch` around the call. As on Workers, an unhandled rejection is now logged
  (`Uncaught (in promise) ...`), fires `unhandledrejection` when the app has a listener
  (`addEventListener("unhandledrejection", ...)`), and the process and other requests keep going. An
  un-awaited `async function` that throws is reported the same way. At every compatibility date.

### Changed

- **Types for the Promise bindings.** `sproutboat types` gives D1 (from compatibility date 2026-10-24),
  KV (2026-10-25) and R2 (2026-10-26) bindings the Promise types (`D1DatabaseAsync`,
  `KVNamespaceAsync`, `R2BucketAsync`); earlier dates keep the synchronous ones.
- Docs, examples and type comments no longer say binding calls are synchronous at every date.

## [0.36.0] - 2026-10-26

Built on `@sproutboat/runtime` 0.34.0, `@sproutboat/toolchain` 0.19.0 and
`@sproutboat/wire` 0.20.2.

### Added

- **WebSockets everywhere, from compatibility date 2026-11-01.** Standalone executables and the
  platform carry the client end of a 101 response (before the date they answer 501), and the
  platform edge proxies the upgrade.
- **Outbound WebSockets, from 2026-11-01.** `new WebSocket(url, protocols)` and
  `fetch(url, { headers: { Upgrade: "websocket" } })` (the Response's `webSocket`, then
  `accept()`); returning that Response from a handler relays the client's socket to the upstream.
  `ws`, `wss`, `http` and `https` URLs. `sproutboat check` and `build` accept `WebSocket(` from
  that date and refuse it before. They run on standalone executables and sproutd; `sproutboat dev`
  and the platform (broker transport) reject `fetch` upgrades for now.
- **Hibernation on sproutd, from 2026-11-01.** A Durable Object's hibernatable socket no longer
  keeps its worker running: the worker is reaped while the socket idles, the auto-response is
  answered without waking it, and a message or close starts a worker that constructs the object
  again with `getWebSockets()` as it was.

### Changed

- `types/sproutboat.d.ts` and the README describe the above. The toolchain moves to 0.19.0, so
  compiled apps get a new fingerprint and rebuild once.

## [0.35.0] - 2026-10-26

Built on `@sproutboat/runtime` 0.33.0, `@sproutboat/toolchain` 0.18.0 and
`@sproutboat/wire` 0.20.1.

### Changed

- **Faster string building in compiled apps.** The toolchain moves to 0.18.0: `s += e;` in a
  loop on a local string appends in place instead of copying the whole string, `replace(regex, fn)`
  joins its pieces once, and `charCodeAt` and `JSON.parse` read characters directly. On sproutd's
  heavy set that is about 40% more requests per second, with regex-scan 7 ms instead of 35 ms.
  Compiled apps get a new fingerprint and rebuild once.

## [0.34.0] - 2026-10-26

Built on `@sproutboat/runtime` 0.33.0, `@sproutboat/toolchain` 0.17.0 and
`@sproutboat/wire` 0.20.1.

### Added

- **WebSockets from compatibility date 2026-10-30.** `WebSocketPair`, `WebSocket`
  (`accept`, `send`, `close`, listeners), `new Response(null, { status: 101, webSocket })`,
  `response.webSocket`, `WebSocketRequestResponsePair`, and the Durable Object hibernation API
  (`acceptWebSocket`, `getWebSockets`, `getTags`, auto-responses, attachments,
  `webSocketMessage` and `webSocketClose`). Behaviour follows workerd. Sockets reaching a client
  are carried by sproutd (B19); a standalone executable or the platform answers a 101 with 501
  for now, while a pair whose ends both stay in the worker (a Worker and its Durable Object)
  works everywhere. Outbound `new WebSocket(url)` is not supported yet.
- Streamed request bodies on sproutd (B19), from compatibility date 2026-10-27.

### Changed

- `types/sproutboat.d.ts` declares the WebSocket types and the hibernation handlers.
- The toolchain moves to 0.17.0, so compiled apps get a new fingerprint and rebuild once.

## [0.33.0] - 2026-10-25

Built on `@sproutboat/runtime` 0.32.0, `@sproutboat/wire` 0.20.0 and
`@sproutboat/config` 0.6.0.

### Added

- **Queue names and consumer settings.** A `queues` entry may be
  `{ "binding": "JOBS", "queue": "jobs", "max_batch_size": 10, "max_batch_timeout": 1,
  "max_retries": 3, "retry_delay": 0, "dead_letter_queue": "failed" }`. The settings
  are named as in wrangler's `queues.consumers`, and `id` is optional there. `batch.queue`
  is the queue's name. The build bakes the settings into `bindings.json` as `queueConfig`,
  and `deploy` pins a provisioned id into such an object. These apply at every compatibility
  date.
- **Queues like Cloudflare's from compatibility date 2026-10-31.**
  - `send()` and `sendBatch()` return Promises of the queue's backlog, and `metrics()` is new.
  - Bodies keep their content type (`json`, `text`, `bytes`, `v8`).
  - Arguments are checked with workerd's errors.
  - Messages carry `timestamp` as a Date of when they were sent, and `retry({ delaySeconds })`.
  - The first of `ack()` and `retry()` wins.
  - By default a retry is immediate, with at most 3 retries before the message is dropped or
    sent to the dead letter queue.
  - Queues conformance: 17/46 before, 41/46 after, standalone and through `sproutboat dev`.
    The other 5 cases follow Cloudflare's documented behaviour where miniflare differs: real
    backlog metrics, and first call wins.

### Changed

- `types/sproutboat.d.ts`: the Queues types follow Workers (`QueueSendResult`,
  `QueueMetrics`, readonly message fields, `metadata`, retry options).

## [0.32.0] - 2026-10-25

Built on `@sproutboat/runtime` 0.31.0, `@sproutboat/toolchain` 0.16.1 and
`@sproutboat/wire` 0.19.1.

### Added

- **Cron-only and queue-only Workers.** A Worker may export only `scheduled()`
  or `queue()`, with no `fetch()`, as on workerd. Cloudflare's `cron-trigger`
  and `multiple-cron-triggers` examples used to be refused at build. An HTTP
  request to such a Worker answers 500 and logs workerd's "Handler does not
  export a fetch() function.".
- Queue consumers and `scheduled()` may be `WorkerEntrypoint` methods.
- Apps built for sproutd get their crons, queue messages and Durable Object
  alarms delivered by the daemon, which starts an app that was shut down while
  idle (sproutd B22). Standalone executables and the platform keep their own
  timers.

### Fixed

- A standalone executable whose only binding-like setting is `triggers.crons`
  now runs its crons. Before, they started only when some other binding existed.
- In standalone executables, `scheduled()` gets `env` from compatibility date
  `2026-09-28`, as on the platform. A throw in it is logged instead of being
  left unhandled.

### Performance

- Smaller idle sprouts: once a sprout goes quiet, the idle collection returns
  all of its freed heap to the OS, not only runs of 256 KiB or more. Compiled
  apps get a new toolchain fingerprint, so they rebuild once.
- Faster allocation-heavy handlers: a collection after a request keeps 16 MiB
  of heap above its top, as plain Porffor does, instead of unmapping it. The
  idle collection still trims it. On othello, `regex-scan` took about 3,600 page
  faults and 17 ms more per request before this.

## [0.31.0] - 2026-10-23

Built on `@sproutboat/runtime` 0.30.0, `@sproutboat/toolchain` 0.15.0 and
`@sproutboat/wire` 0.19.0.

### Added

- More of Durable Objects like workerd, from compatibility date `2026-10-29`:
  - **RPC on stubs.** In a class that extends `DurableObject` from
    `cloudflare:workers`, `await stub.method(args)` calls the method through
    the object's input gate.
    - Arguments and results are copied as structured clone does, so Date, Map,
      BigInt, `Uint8Array` and the like keep their type.
    - A function argument becomes a callback.
    - A getter is read with `await stub.prop`.
    - A throw rejects the caller with the same error.
  - **Ids are 64 hex digits** and have `equals()` and `name`. `idFromString`
    rejects malformed ids and ids from another namespace.
  - `namespace.getByName(name)`, `namespace.jurisdiction()`, and `stub.id` and
    `stub.name`.
  - **`ctx.storage.sql`**: each object has its own SQLite database.
    - `exec()` returns cursors with `toArray()`, `one()`, `raw()` and iteration.
    - `storage.transactionSync()` and `sql.databaseSize` are available.
    - Foreign keys are enforced.
    - `BEGIN` and `SAVEPOINT` are refused, as on Workers.
- On the sproutd Durable Objects suite, these bring do.js from 67 to 93 of 105
  and do-rpc.js from 1 to 17 of 17.

### Changed

- From `2026-10-29`, an exception thrown inside a Durable Object rejects
  `stub.fetch()` with that error, as on Workers. It used to come back as a 500
  response.
- Moving an app to `2026-10-29` keeps its Durable Object data. Storage and
  alarms of objects created with `idFromName` before that date move to the new
  64-hex ids on first use. `idFromString` still accepts the `name:` and `uid:`
  ids that earlier dates gave out.

## [0.30.0] - 2026-10-23

Built on `@sproutboat/runtime` 0.29.1, `@sproutboat/toolchain` 0.15.0 and
`@sproutboat/wire` 0.18.0.

### Fixed

- Queues lost data in standalone executables. `sendBatch()` stored every
  message body as the text `"[object Object]"`, and a consumer whose `queue()`
  threw had its whole batch acked. Now the bodies arrive intact, and a throw
  retries every message the consumer had not acked or retried, as on Workers.
  `send()` and `sendBatch()` also honour `delaySeconds` there. These fixes
  apply at every compatibility date.

### Added

- Durable Objects like workerd from compatibility date `2026-10-28`:
  - An input gate: while a storage read is in flight, no other request or alarm
    enters the object, so read-then-write updates are no longer lost under
    concurrency. Ten concurrent increments used to end at 1.
  - Storage methods return Promises, and `transaction()` and `sync()` are
    available.
  - Values keep their type: Date, Map, Set, RegExp, BigInt, `Uint8Array`,
    `DataView`, `ArrayBuffer` and more. Other typed arrays throw a DataCloneError
    in `put()`, for now: store their bytes in a `Uint8Array`.
    `put(key, undefined)` throws, as on Workers.
  - `list()` takes `start`, `startAfter`, `end` and `reverse`.
  - `deleteAll()` also removes the alarm.
  Earlier dates keep synchronous JSON storage.
- From `2026-10-28`, `sendBatch(messages, { delaySeconds })` delays the whole
  batch.

### Changed

- A Durable Object `list({ prefix })` matches the prefix exactly at every date.
  `_` and `%` were wildcards, and case was ignored.

## [0.29.0] - 2026-10-23

Built on `@sproutboat/runtime` 0.28.0, `@sproutboat/toolchain` 0.15.0 and
`@sproutboat/wire` 0.17.0.

### Added

- Offline restore of a captured D1 database, inside the app's own executable.
  `sproutboat build --standalone --with-restore` adds an `ltx-restore` command:
  `./my-app ltx-restore --generation DIR --output NEW_DB [--txid N]` rebuilds a
  SQLite database from one generation of LTX files written by native capture.
  The target needs no Node, Bun or SQLite CLI. The restore checks every
  checksum and TXID in the chain, then runs SQLite's integrity check on the
  result. It refuses to run while capture is still writing, and never
  overwrites an existing file or touches the destination's `-wal`/`-shm`
  sidecars. On success it prints the TXID, checksum and size as JSON. See
  `docs/native-ltx-restore.md`.
- The restore code is compiled separately from the app and runs before any app
  code starts. Builds without `--with-restore` are unchanged, and there an
  `ltx-restore` argument does nothing.

## [0.28.0] - 2026-10-23

Built on `@sproutboat/runtime` 0.28.0, `@sproutboat/toolchain` 0.14.0 and
`@sproutboat/wire` 0.17.0.

### Added

- Request bodies stream from compatibility date `2026-10-27`, as in Workers.
  The handler runs as soon as a request's headers arrive, and `request.body`
  hands out the bytes as they come in. The server pauses the connection while
  more than 1 MiB waits unread, so a 128 MiB upload read through the stream
  peaks at 38 MiB. `text()`, `json()`, `arrayBuffer()` and `bytes()` still read
  the whole body (as Promises). New example: `examples/upload`.
- From the same date `SB_REQUEST_BODY_MAX` defaults to 100 MiB (it stays 1 MiB
  before it, where the body is held whole). A larger `Content-Length` gets
  `413 Payload Too Large` before the handler runs.
- On the platform, `fetch()` and service bindings send a `ReadableStream`
  request body as it is read, instead of reading it to the end first. A
  streamed body can't follow a 307 or 308 redirect, as in Workers.

Earlier dates are unchanged: the handler gets the whole body, and
`request.text()` answers at once.

## [0.27.0] - 2026-10-22

Built on `@sproutboat/runtime` 0.27.1.

### Fixed

- Bodies of megabytes no longer take hundreds of megabytes of memory. Turning
  bytes into text and text into bytes made one string per character, so reading
  a 5 MiB R2 object with `text()` peaked at about 400 MiB, and R2 multipart
  uploads with real (5 MiB) parts ran sproutd's workers out of memory. On a
  standalone build, at 5 MiB: `put()` of a string 82 to 16 MiB, `get()` and
  `text()` 400 to 26 MiB, `request.text()` 402 to 24 MiB.
- R2 `uploadPart()` stores an `ArrayBuffer` or a typed array as its bytes, at
  every date. It stored the text `[object ArrayBuffer]`.
- From compatibility date `2026-10-26`, `uploadPart()` takes what `put()` takes
  (a `ReadableStream` or a `Blob` too) and stores text as UTF-8, as in Workers.

## [0.26.0] - 2026-10-22

Built on `@sproutboat/runtime` 0.27.0 and `@sproutboat/wire` 0.16.0.

### Changed

- R2 behaves as in Workers from compatibility date `2026-10-26`:
  - `get`, `put`, `head`, `delete`, `list` and `createMultipartUpload` return
    Promises, and errors reject them.
  - An object's `etag` is the MD5 of its bytes, with `checksums.md5`. Objects
    written before keep their old etag.
  - Objects have `uploaded` as a `Date`, `version`, `storageClass`, `range` and
    `writeHttpMetadata(headers)`. A body has `body` (a `ReadableStream`),
    `bodyUsed`, `text()`, `json()`, `arrayBuffer()` and `blob()`.
  - `get(key, { range, onlyIf })` takes `{ offset, length }`, `{ suffix }` or a
    `Range` header, and `etagMatches`, `etagDoesNotMatch`, `uploadedBefore`,
    `uploadedAfter` or `If-*` headers. When the condition fails it returns the
    object without a body.
  - `put(key, value, { onlyIf, httpMetadata })` takes a `ReadableStream` or a
    `Blob`, and `httpMetadata` as `Headers`. When the condition fails it returns
    `null`.
  - `delete([keys])` deletes several keys.
  - `list({ prefix, limit, cursor, delimiter, include })` pages at up to 1,000
    entries, groups keys into `delimitedPrefixes`, and returns `httpMetadata` and
    `customMetadata` only when `include` asks for them.
  - A value of the wrong type and a key longer than 1,024 bytes fail with R2's
    errors.

  Apps with an earlier date keep the synchronous R2. Move `compatibility_date`
  to `2026-10-26` to opt in.

### Fixed

- An R2 `list()` prefix matches exactly, at every compatibility date. It used
  SQL `LIKE`, so it ignored case and read `_` and `%` as wildcards.

## [0.25.0] - 2026-10-22

Built on `@sproutboat/runtime` 0.26.0 and `@sproutboat/wire` 0.15.0.

### Changed

- KV behaves as in Workers from compatibility date `2026-10-25`:
  - `get`, `getWithMetadata`, `put`, `delete` and `list` return Promises, and
    errors reject them.
  - `get(key, type)` takes `"text"`, `"json"`, `"arrayBuffer"` and `"stream"`;
    `get([keys])` returns a `Map`.
  - `put()` takes strings, bytes and `ReadableStream`s, with `expiration`,
    `expirationTtl` and `metadata`; `getWithMetadata()` returns the metadata.
  - `list({ prefix, limit, cursor })` returns each key's `expiration` and
    `metadata`, `list_complete` and `cursor`, and pages at up to 1,000 keys.
  - Bad keys, values, expirations, metadata and limits fail with KV's own errors.

  Apps with an earlier date keep the synchronous KV. Move `compatibility_date`
  to `2026-10-25` to opt in.
- D1 behaves as in workerd from compatibility date `2026-10-24`:
  - every call except `bind()` returns a Promise, and errors reject it;
  - `meta` has D1's keys, `raw({ columnNames: true })` and `first("name")` work
    as in D1, and `withSession()` returns a session;
  - parameters, parameter counts and foreign keys are checked as in D1, and
    errors read `D1_ERROR: <message>: SQLITE_<CODE>`;
  - `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` and `RELEASE` are refused, and
    `exec()` runs line by line, all or nothing.

  Apps with an earlier date keep the synchronous D1.

### Added

- A storage quota for an app's data directory (KV, D1, R2, Durable Object
  storage, queues): `SB_STORAGE_MAX_BYTES`, 10 GiB by default. Past it, writes
  fail with an error that says so, and reads and deletes keep working. The size
  is measured at most once a second, so the write that crosses the limit is
  accepted. With LTX capture on, an over-quota D1 database refuses every write
  until the app is under its quota again.

### Fixed

- These apply at every date:
  - D1 bytes are no longer lost: a `Uint8Array`, `DataView` or `ArrayBuffer`
    parameter stored NULL in a standalone sprout, with every parameter after it.
  - A standalone sprout's D1 `batch()` is one transaction, as in D1.
  - `meta.changes` is 0 for a statement that only reads.
  - A KV `list()` prefix matches exactly. It used SQL `LIKE`, so `a_` also
    listed `ab`, and `a` also listed `AB`.
- The quota counts a D1 database's WAL file. While the app is over its quota,
  the runtime now checkpoints and truncates the WAL before measuring again, so
  `DELETE` then `VACUUM` is enough to get back under it.
- LTX capture starts when a worker's filesystem sandbox allows writes only
  under its own state directory: its scratch index file now lives in the
  database's replication spool, not the global temporary directory.

## [0.24.0] - 2026-10-22

### Changed

- `fetch(Request)`, `fetch(Request, init)` and `new Request(request, init)` behave
  as in workerd from compatibility date `2026-10-23` (`@sproutboat/runtime` 0.23.0,
  `@sproutboat/toolchain` 0.13.0). This covers outgoing `fetch()`, service
  bindings and Durable Object stubs.
  - The Request's method, headers, body, redirect mode and signal apply unless
    `init` replaces them.
  - A body can be used only once: sending or copying a used Request throws.
  - GET and HEAD refuse a body, and an incoming GET has `request.body === null`.
  - Unknown methods, `CONNECT` and `redirect: "error"` throw, as in workerd.
  - The headers of incoming requests, fetched responses and
    `Response.redirect()` are immutable. Copy them to change them.

  Apps with an earlier date keep the old behaviour. Move `compatibility_date` to
  `2026-10-23` to opt in.

### Fixed

- These apply at every date:
  - `Request.signal` exists, and `fetch()` aborts with a Request's signal.
  - A `ReadableStream` body in an outgoing `fetch()` is sent as its bytes. It
    used to go out as the text `[object ReadableStream]`.
  - `clone()` of a Request or Response with a stream body gives both copies
    the whole body.
  - A copy of an incoming request keeps its raw bytes.

### Added

- `examples/request`, built at `2026-10-23` and checked by `bun run examples`:
  forwarding an incoming request and the Request rules above.

## [0.23.0] - 2026-10-22

### Added

- Experimental local backup of a D1 database to LTX files, in standalone
  binaries (`@sproutboat/runtime` 0.22.0). It's off by default. To turn it on, set
  the compatibility date to `2026-10-22` or later, `SB_LTX_ENABLE=1`, and
  `SB_LTX_DATABASE=<binding>`. Every committed transaction is then written to a
  durable LTX file, and the app resumes from the last one after a restart.
  - Only one process may write to the database.
  - Files stay on local disk; uploading them is not part of this release.
  - See the runtime's `LTX_REPLICATION.md` for limits and recovery behaviour.

## [0.22.0] - 2026-10-22

### Added

- `sproutboat build --standalone --emit-only` writes
  `.sproutboat/porffor-units/linux-x86_64-embedded-release/sprout.generated.js`,
  byte for byte what a full standalone build compiles, prints its path and
  stops. It runs every check that can fail a build, but acquires no Zig,
  SQLite, BearSSL or Porffor and writes no binary, so it takes well under a
  second where a full build takes tens of seconds. Without `--standalone` it
  emits the broker-transport module the same way.

### Fixed

- The `d1`, `queue` and `analytics` examples read the request body with
  `await request.text()` rather than as `request.body`. From compatibility date
  `2026-10-21`, `request.body` is a `ReadableStream`, as in Workers, so
  `JSON.parse(request.body)` threw `SyntaxError: Unexpected token` and a D1
  example moved to a current date answered every POST with a 500. The new form
  works at every date. `bun run examples` now also builds the d1 example at
  `2026-10-22` (`d1@2026-10-22`), so an example that only works before that
  date fails the run.

### Changed

- `@sproutboat/toolchain` 0.12.1: heap-backed BigInts stay alive through
  conservative garbage collection, which fixes crashes and wrong checksums in
  BigInt-heavy code such as CRC64 and LTX encoding. `@sproutboat/wire` 0.14.1.

## [0.21.0] - 2026-10-21

### Changed

- Apps compile with Porffor Alpha 19 (`@sproutboat/toolchain` 0.12.0).
  Binaries are about 1.5% smaller, and build times are unchanged.
- Alpha 19 brings JavaScript closer to V8, and the changes apply at every
  compatibility date:
  - `Error.prototype.stack` is an accessor;
  - `instanceof` follows the spec, including `Symbol.hasInstance`;
  - sloppy-mode functions box a primitive `this`;
  - undeclared names are read from the global object;
  - using a `let`, `const` or class binding before its declaration throws.

### Fixed

- `JSON.parse` with a reviver now gives the reviver the right `context.source`
  when the input contains non-ASCII text.
- `Map.groupBy` works, and private class fields no longer show up as
  enumerable properties.

## [0.20.0] - 2026-10-21

### Added

- Workers RPC over service bindings. A target whose default export extends
  `WorkerEntrypoint` (from `cloudflare:workers`) exposes its methods:
  `await env.SERVICE.add(2, 3)` runs `add(2, 3)` on it and resolves to the result.
  - Arguments and results are copied as structured clone does (`Date`, binary data,
    `Map`, `Set`, `undefined`, `NaN`, `-0`).
  - An error the method throws rejects the call with the same class and message.
  - `cloudflare:workers` also provides `DurableObject`, `RpcTarget` and `env`.
- Compatibility date `2026-10-22` changes how `fetch()` and `env.SERVICE.fetch()`
  behave in a deployed app:
  - They return promises and no longer block. The app keeps serving other requests
    while a call is in flight, concurrent calls overlap, and a deployment can call
    itself through a binding.
  - Responses stream: the call resolves when the headers arrive, and `response.body`
    receives chunks as they come.
  - Redirects are followed as Fetch does (`redirect: "manual"` and `"error"` work).
  - A service-binding target that throws makes the caller throw the same error, and
    the target sees the URL its caller passed.

  Apps with an earlier `compatibility_date` keep getting a `Response` right away, as
  before. Move the date to `2026-10-22` and rebuild to opt in.
- `fetch()` and service bindings honour `init.signal`. Aborting stops the work
  downstream too.

### Fixed

- Every `Set-Cookie` header of a fetched response is kept, not just the last one.
- A fetched response without a `Content-Type` no longer gains `text/plain`.
- `atob()` and `btoa()` were wrong for strings from `JSON.parse` or `TextDecoder`;
  they are now correct for any string.
- A `fetch` or service call is no longer retried once the broker may have run it.

toolchain 0.11.0, runtime 0.21.1, wire 0.14.

## [0.19.0] - 2026-10-21

### Added

- From compatibility date `2026-10-21`, `Response.body` and `Request.body` are
  `ReadableStream`s for every body type, as in Fetch and workerd: `res.body.getReader()`,
  `res.body.pipeThrough(...)` and `new Response(upstream.body)` work on any response,
  including the incoming request. Apps with an earlier `compatibility_date` keep the raw
  body (`JSON.parse(request.body)`, as the examples do); move the date and rebuild to opt in.

### Fixed

- `env.BUCKET.put(key, request.body)`, `env.KV.put(key, request.body)` and
  `fetch(url, { body: request.body })` take the request body, stream or not.
- A non-ASCII request body is no longer UTF-8 encoded twice by `arrayBuffer()`,
  `blob()` or KV `put` (`é` arrived as `Ã©`), and R2 `put` accepts bytes.

## [0.18.0] - 2026-10-20

### Added

- Porffor Alpha 18 (`@sproutboat/toolchain` 0.9, `@sproutboat/runtime` 0.18).
- Standalone sprouts stream `ReadableStream` response bodies chunk by chunk, so
  Server-Sent Events and long responses work; a client that disconnects cancels
  the stream.
- `HTMLRewriter` (Cloudflare's API, output matching lol-html),
  `CompressionStream`/`DecompressionStream` (gzip, deflate, deflate-raw),
  `structuredClone`, `Event`/`EventTarget`/`AbortController`,
  `TextEncoderStream`/`TextDecoderStream`, and more Web Crypto (SHA-1, MD5,
  HMAC-SHA1, `exportKey`, `generateKey`).
- Fetch-spec `Request`, `Response`, `Headers`, `Blob` and `FormData`: byte bodies
  go out as bytes, body readers read `ReadableStream` bodies, and `JSON.parse`
  applies its reviver.

### Fixed

- `ctx.waitUntil` work no longer delays the response.
- `setTimeout(fn, 0)` fires on Linux.
- An edited compiler patch no longer hides behind a stale Porffor cache.

### Changed

- `Response.redirect` sends the serialized URL (`https://example.com/`), and a
  204/205/304 response with a body throws, per Fetch and workerd.
- Porffor's build cache keeps the 100 most recent builds.

## [0.17.0] - 2026-10-11

### Added

- Native Web Streams globals and global timeout/interval functions. HTTP bodies
  remain buffered.
- A pinned Better Auth 1.7.1 integration probe covering email/password signup,
  signed-cookie sessions, wrong-password rejection, signin and signout with
  an explicit memory database adapter and default password hashing.

### Changed

- Upgrade to Porffor Alpha 17, fixing dynamic number conversion, Math.round
  ties, negative zero, console precision and class-field captures.
- Fix lexical local-function return types and Uint8Array base64 options,
  padding and decoding. AES/JWE stateless auth sessions remain unsupported;
  native default password hashing currently takes about six seconds.

## [0.16.0] - 2026-10-10

### Added

- Proxy and revocable Proxy are accepted in handlers with Porffor alpha-16.
  Native regression checks cover property traps, enumeration, callable and
  constructible proxies, revocation, and frozen-property invariants.

- `URLSearchParams` and `FormData` provide live keys, values and entries
  iterators. `itty-router` 5.0.24 `IttyRouter` passes GET parameters, Unicode
  POST bodies and a 404 fallback. A basic tRPC 11.19.0 server caller also works.

### Changed

- Pin Porffor alpha-16 (`43087d4`) through `@sproutboat/toolchain` 0.6.0
  and `@sproutboat/runtime` 0.15.0. Collection iterator methods and `matchAll`
  now return iterators. Typed-array `from`, `set` offset and `join` fixes are
  supplied upstream, so their local source patches are removed.
- Native output handles Unicode console strings, clamped-array ties round
  to even, and class static initializers use the class as `this`.

### Compatibility limits

- Proxy support alone does not establish compatibility for every package.
  `qs` 6.16.0 parses and serializes nested query data in a native HTTP probe.
  Standard `itty-router` 5.0.24 `Router` still hits a labelled-break compiler
  error. String iteration still splits astral characters into UTF-16 halves.


## [0.15.0] - 2026-10-05

### Changed

- Sprouts compile with Porffor alpha-15 (`@sproutboat/toolchain` 0.5.0).
  Async functions now compile to state machines, and `console.log` no longer
  adds colour codes when its output is piped. The compatibility suite is
  unchanged at 30/32, and binary size, compile time, start-up and throughput
  are level with alpha-13.

### Performance

- Rebuilding after a small change is about 3 times faster: 2.1 to 2.4 s
  instead of 6.8 to 7.7 s for the standalone example app. Builds now compile
  from one path per project, so Porffor reuses the C units that didn't change.
  Porffor's build directories that haven't been used for a week are removed;
  they used to pile up without limit.

### Fixed

- Handlers using marked, or any bundled class whose static methods create
  instances of the class itself, work again. Since 0.12.6 they failed with
  `TypeError: value is not a constructor` (baronunread/sproutboat#256).
- An ISO date's timezone offset could flip sign, so `-00:30` sometimes parsed
  as `+00:30`, depending on what sat next to the string in memory.

## [0.14.0] - 2026-10-04

### Changed

- `fetch()` reaches any public address with no configuration, and never a
  private or reserved one: loopback, private networks, link-local and cloud
  metadata, and their IPv6 forms. The check runs on the resolved address at
  connect time, in deployed sprouts and standalone binaries alike. Operators can
  allow specific addresses with `SB_EGRESS_ALLOW`
  (baronunread/sproutboat#174).
- Every build writes `bindings.json`, so every deployment gets a broker.

### Deprecated

- `outbound` in `sproutboat.jsonc` is ignored with a warning, and will be
  refused in a later release.

### Fixed

- `fetch()` to an IPv6 literal such as `http://[::1]:9/` works in standalone
  binaries; `URL.hostname` used to come back as `[`.

## [0.13.0] - 2026-10-04

### Added

- `sproutboat build` reads `_headers` and `_redirects` (Cloudflare Pages
  format) from the assets directory and writes the rules into `assets.json`.
  The deployed edge applies them: redirects before any file lookup, header
  rules on edge-served files (baronunread/sproutboat#61).

## [0.12.7] - 2026-10-03

### Fixed

- Writing past the end of a typed array is ignored instead of overwriting
  neighbouring memory. `a[-1] = x` no longer writes `a[0]`
  (`@sproutboat/toolchain` 0.4.23, baronunread/sproutboat#241).
- `join()` and `toString()` work on typed arrays. `Uint8Array.join` returned
  garbage, and a `Uint16Array.join` could kill the process
  (`@sproutboat/toolchain` 0.4.24, baronunread/sproutboat#242).
- KV stores binary values: `put()` of an `ArrayBuffer` or typed array keeps
  its bytes instead of storing `"0,1,2,..."`. `get(key, type)` supports
  `"text"`, `"json"` and `"arrayBuffer"` (baronunread/sproutboat#233).
- `fetch()` and service-binding request bodies send an `ArrayBuffer` or typed
  array as its exact bytes, in standalone builds and through the broker. The
  standalone client also no longer cuts a body off at its first zero byte
  (`@sproutboat/runtime` 0.13.5, `@sproutboat/wire` 0.9.3,
  baronunread/sproutboat#232).

## [0.12.6] - 2026-10-03

### Fixed

- `String.prototype.replaceAll` is linear: replacing in a 2.1 MB string took
  about 42 s and now takes 71 ms (`@sproutboat/toolchain` 0.4.20,
  baronunread/sproutboat#237).
- uuid and @noble/hashes work. Four compiler bugs and one runtime bug were
  behind them (baronunread/sproutboat#238):
  - Integer typed-array stores wrapped wrongly: `uint32[i] = x | 0` stored 0
    for negative `x`, and `fill`/`set`/`from` were affected too.
  - `typedArray.set(source)` with no offset copied nothing and wrote into the
    wrong memory.
  - `~x` was wrong for values above 2^31.
  - Typed-array reads past the end returned neighbouring memory instead of
    `undefined`.
  - A handler's own top-level `URL` (uuid exports one) replaced the runtime's
    `URL` class and crashed the binary at startup. The handler now runs in its
    own scope.

  SHA-256, HMAC and uuid v5 now match Node (`@sproutboat/toolchain` 0.4.22,
  `@sproutboat/runtime` 0.13.4).

## [0.12.5] - 2026-10-02

### Fixed

- Floating-point results on arm64 now match JavaScript. The C compiler fused
  `a * b + c` into one instruction that rounds once, where JavaScript rounds
  twice, so code like a seeded random-number generator drifted from V8.
  Builds now use `-ffp-contract=off` (`@sproutboat/toolchain` 0.4.18,
  baronunread/sproutboat#235).
- Standalone binaries answer HTTP/1.0 requests instead of returning
  `505 HTTP Version Not Supported`, so they work behind nginx's default
  `proxy_http_version 1.0`. The connection closes after the response, as
  HTTP/1.0 expects (`@sproutboat/toolchain` 0.4.19,
  baronunread/sproutboat#236).
- Binary responses from outbound `fetch()` and service bindings arrive intact.
  `arrayBuffer()` and `bytes()` returned a corrupted body (a 31,340-byte font
  came back as about 30,000 bytes), in standalone builds and through the
  broker alike. `text()` and `json()` are unchanged (`@sproutboat/runtime`
  0.13.3, `@sproutboat/wire` 0.9.2, baronunread/sproutboat#232).

### Changed

- The standalone kitchen-sink checks a raw HTTP/1.0 request.

## [0.12.4] - 2026-10-01

### Fixed

- Non-ASCII text read back from bindings no longer comes back garbled:
  `"café"` was returned as `"cafÃ©"` from D1 rows, KV values, cached
  responses, R2 metadata and SQLite error messages, in standalone builds,
  `sproutboat dev` and platform deployments alike. The data itself was stored
  correctly. Fixed in `@sproutboat/runtime` 0.13.1
  (baronunread/sproutboat#189).
- Async handlers no longer start failing on every request after a few
  requests. An async function returning `null` (an anonymous session lookup,
  say) had its promise rejected with `TypeError: Cannot get property of null`
  once a `new Date().toISOString()` call had run, and the handler never
  recovered. The cause is a Porffor promise-resolution bug, patched in
  `@sproutboat/toolchain` 0.4.17 (baronunread/sproutboat#168).
- Uncaught exceptions from `fetch`, `scheduled()` and `alarm()` are now logged
  to stderr as `Uncaught (in fetch) Error: ...` before the 500. They used to be
  swallowed silently (`@sproutboat/runtime` 0.13.2).

### Changed

- The kitchen-sink example reads its JSON body with `request.json()`, which
  decodes UTF-8, instead of parsing `request.body`, which holds the raw bytes.
  Its conformance suite now checks that non-ASCII text round-trips through D1.

## [0.12.3] - 2026-10-01

### Changed

- Builds use Porffor alpha-13 (`547c781`), up from alpha-10, through
  `@sproutboat/toolchain` 0.4.16. Alpha-11 to alpha-13 add array and typed
  array fast paths, closure and module codegen fixes, a basic `RegExp`
  search, a `String.prototype.normalize` stub and lowercase JSON hex escapes.
  Compatibility is unchanged at 30/32 handlers and binaries are about 1.7%
  smaller.

## [0.12.2] - 2026-10-01

### Fixed

- `sproutboat dev` no longer kills a large app's sprout with SIGBUS (exit 138)
  on its first request. Every async function runs on its own fiber stack,
  which Porffor fixes at 256 KiB, and the unoptimised code `dev` builds
  overflowed it within a few nested awaits. `@sproutboat/toolchain` 0.4.15
  raises it to 8 MiB; only touched pages cost memory. Release builds had the
  same limit at a higher threshold, so a deep async chain could crash a
  deployed sprout the same way (baronunread/sproutboat#178).

## [0.12.1] - 2026-09-30

### Fixed

- `sproutboat` with no arguments linked the platform repository and said to
  use `bunx`, not `npx`. The CLI has shipped as a self-contained binary since
  0.11.0, so `npx` works; the help now links https://docs.sproutboat.com.
- Handler types now declare `batch.ackAll()`/`retryAll()`, per-message
  `delaySeconds` in `sendBatch()` and D1 `raw()`, matching the runtime.
  Comments that said direct R2 uploads are unavailable standalone, and that an
  un-acked queue message is redelivered, are corrected.

### Changed

- `examples/runtime-comparison` runs one Worker-style app on Node, workerd and
  a standalone Sproutboat binary and checks every response;
  `benchmarks/v0.12.0` holds the first tagged run, which sproutboat.com
  renders.

## [0.12.0] - 2026-09-28

### Added
- Run three original Cloudflare Worker examples unchanged: JSON responses,
  cookie parsing, and redirects. The example suite now checks 21 native apps.
- Pass `(request, env, ctx)` to fetch handlers using the 2026-09-28
  compatibility date while preserving the earlier two-argument form for older apps.

### Changed
- Update to Porffor alpha 10 via `@sproutboat/toolchain@^0.4.14` and use
  `@sproutboat/runtime@^0.13.0` for native request decoding and redirects.

## [0.11.13] - 2026-09-26

### Added
- Record compile duration in the artifact manifest so the platform can show it per deployment.
- Support selected `node:path`, `node:url`, and `node:querystring` APIs in handlers.

### Changed
- Reuse checksum-verified native binaries for identical release builds and
  refresh broker asset sidecars without recompiling the handler.
- Report native compilation time and binary cache status after `build`.
- Reject unsupported service bindings before starting a standalone build.
- Fetch the pinned Mozilla CA bundle from curl's dated archive so new upstream
  revisions do not break fresh standalone builds.
- Update the pinned toolchain to `0.4.13` and the artifact contract to `0.3.0`.

## [0.11.12] - 2026-09-24

### Changed
- Porffor alpha 9 handles ESM modules without the external esbuild executable.
  The CLI now requires `@sproutboat/toolchain@^0.4.12`, runtime `^0.12.1`,
  and wire `^0.9.1`.
  Removed the CLI's esbuild dependency, platform binary copies, and compile-time
  PATH lookup. Handler validation and shimming still use Bun's built-in bundler.
  The required `esbuildVersion` manifest field remains for older artifact
  readers and now records `unused`.
- Local `dev` rebuilds keep a stable generated entry path for each process, so
  Porffor alpha 9 can reuse unchanged compiled C units. In a local `hello`
  handler-edit comparison, compilation took 549 ms with the stable path versus
  1,505 ms with changing paths. Candidate binaries remain isolated.

## [0.11.11] - 2026-09-24
### Fixed
- Updated the native runtime to `0.12.0` so repeated HMAC signing uses the raw
  digest bytes between rounds, matching WebCrypto and existing password hashes.
- Updated the toolchain to `0.4.11` so `Uint8Array.from({ length: 16 }, mapFn)`
  produces the intended key bytes in standalone native builds.
- Added the two-round HMAC vector to broker and standalone conformance checks.
## [0.11.10] - 2026-09-18
### Changed
- Bumped `@sproutboat/toolchain` to `0.4.10`, pinning Porffor to the
  `alpha-7` tag. All local patches (render.js, uwebsockets.js) verified
  against the real alpha-7 source — no anchor drift, kitchen-sink
  conformance and the full test suite pass.

## [0.11.9] - 2026-09-17
### Fixed
- Bumped `@sproutboat/toolchain` to `^0.4.9` and `@sproutboat/runtime` to
  `^0.9.6`. `0.11.6`'s toolchain pin (`^0.4.5` since `0.4.2`) predated a
  native R2 size-gating feature that shipped in `0.4.6`/`0.4.7` with a
  misplaced `#endif` in the generated C++ guard, breaking every R2-free
  native build with a compiler error. The fix landed as `0.4.8`, but that
  version got stuck permanently conflicted on npm after an interrupted
  trusted-publish attempt, so `0.4.9`/`0.9.6` revert the feature outright
  instead: R2 transfer support is native code again, always compiled in
  with 404 stubs where unused, same as before it existed. It saved ~11KB
  of `__text` (~1.3% of a typical binary) and didn't even change the
  shipped file size on macOS, since `__TEXT` is page-aligned there — not
  worth the guard-placement bug class it introduced.

## [0.11.8] - 2026-09-17
### Fixed
- Bumped `@sproutboat/runtime` to `^0.9.4`, fixing broker-backed
  native-fetch builds after the direct R2 download ABI gained an `ETag`
  accessor.

## [0.11.7] - 2026-09-16
### Added
- Direct R2 transfers now route through the local dev broker, so `sproutboat
  dev` exercises the same upload/download path a deployed sprout uses
  instead of a separate dev-only stand-in. Documented with a new R2
  multipart upload guide.

### Fixed
- Direct transfer connections no longer produce spurious log noise.
- Bumped `@sproutboat/toolchain` to `^0.4.2`, updating the pinned Porffor
  compiler to alpha 6 and removing a promise-resolution workaround alpha 6
  superseded.

### Changed
- CI now cross-builds the macOS x64 CLI on a macOS 14 runner.

## [0.11.6] - 2026-09-15
### Fixed
- The 100% CPU livelock on a `fetch` handler that resolves a promise with a
  plain object (baronunread/sproutboat#168). Root cause was
  `__Porffor_promise_resolve`'s `.then` duck-type probe spinning forever on a
  prototype-chain fixed point instead of terminating; patched in
  `@sproutboat/toolchain` alongside the other local Porffor patches. Bumped
  `@sproutboat/toolchain` to `^0.4.1` to pick it up.
- `new Response(r2Object.body)` corrupted any binary R2 object (each byte
  0x80-0xFF doubled on the wire): the runtime couldn't tell opaque bytes
  apart from a Latin-1-range string, so it UTF-8-encoded them a second time
  (baronunread/sproutboat#177). Added `R2Object.toResponse(init?)`, which
  serves the bytes unmodified. Bumped `@sproutboat/runtime` to `^0.7.1` and
  `@sproutboat/wire` to `^0.6.0` to pick this up, along with the R2
  file-backed storage rework (baronunread/sproutboat#56) both depend on.
- `sproutboat-env.d.ts`'s generated secret comment named the wrong command
  (`secrets set`; the real one is `secrets put`), `SproutboatHandler` claimed
  there is no `ctx`/`ctx.waitUntil` (shipped since #57/#171), and
  `docs/standalone.md` still said a missing secret refuses the boot (0.11.1
  changed that to throwing on first use instead).

## [0.11.5] - 2026-09-14
### Fixed
- Bumped `@sproutboat/runtime` to `^0.6.6`. `__sbEntry` called `handlers.fetch()`
  (and the `scheduled`/`queue`/`alarm` trigger paths) with no try/catch at all:
  any synchronous throw, or a rejected async handler promise, propagated all
  the way up and crashed the whole process: not just the request that hit
  it, but every other in-flight and future request on that sprout, until
  whatever supervises it restarted the binary (baronunread/sproutboat#179). A
  throwing/rejecting `fetch()` now returns a 500 instead. `scheduled()`/
  `alarm()` still reply `204` either way (no failure signal existed before
  this either); a throwing `queue()` falls through to the existing
  default-ack pass, same as a handler that never calls `ack()`/`retry()` on
  every message.
- Upgrading the CLI is the only way to pick this up. The runtime prelude is
  embedded in the CLI binary when that binary is built, so a project's own
  `@sproutboat/runtime` dependency has no effect on `--standalone` or
  `--target host` builds.

## [0.11.4] - 2026-09-14
### Fixed
- Bumped `@sproutboat/runtime` to `^0.6.5`, undoing a severe performance
  regression that `v0.11.3` shipped (baronunread/sproutboat#181). `0.6.4`'s
  encode fix was correct for the large inputs it targeted and badly wrong for
  small ones: an app hashing ~150-byte values through `crypto.subtle.digest`
  on every request lost **64% of its throughput** (4,700 to 1,680 req/s),
  tripled its p50 (4.6ms to 13.4ms) and grew 41% in RSS. The encoder now only
  reaches for an array once 512 bytes have accumulated, so a small input runs
  exactly like `v0.11.2` while a large one keeps the `#180` fix.
- Upgrading the CLI is the only way to pick this up. The runtime prelude is
  embedded in the CLI binary when that binary is built, so a project's own
  `@sproutboat/runtime` dependency has no effect on `--standalone` or
  `--target host` builds. Anyone on `v0.11.3` should move to this release;
  `v0.11.2` is the last unaffected version before it.

### Changed
- The `darwin-x64` platform package is now cross-compiled on the arm64 macOS
  runner instead of built natively on `macos-13`. GitHub's only x64 macOS pool
  routinely left that leg queued for 30+ minutes and blocked two releases,
  including `v0.11.3`, where the root package published while its own
  `optionalDependency` on `@sproutboat/cli-darwin-x64` was still waiting on it.
  Nothing in the package needs x64 hardware to produce. `scripts/build-cli.ts`
  gains `--target <os>-<arch>` for this.

## [0.11.3] - 2026-09-14
### Fixed
- Bumped `@sproutboat/runtime` to `^0.6.4`, picking up the encode-side half of
  the same `O(n^2)` string-building bug `v0.11.2` fixed on the decode side.
  `__sbToBytes` sits behind every `crypto.subtle` call a handler makes:
  `digest`, `importKey`, `sign`, `verify` and the PBKDF2/scrypt path all funnel
  their data, keys, salts and signatures through it, so hashing a request body
  was quadratic in the body's size. `__sbHexOrBytes`, which decodes the
  `expected` side of an HMAC verify, was worse still; it rewrote its
  accumulator's last character on every odd nibble, copying the whole string
  twice per byte (baronunread/sproutboat#180).

## [0.11.2] - 2026-09-14
### Fixed
- Bumped `@sproutboat/runtime` to `^0.6.3`. `v0.11.1` bumped it to `^0.6.2`,
  which fixed the mojibake but not a second, compounding bug in the same
  code path: `__sbFromUtf8` built its result with repeated `out +=` string
  concatenation, which is `O(n^2)` in Porffor's runtime (no rope/cons
  string optimization). A fresh install of `v0.11.1` silently carried this
  forward, since `^0.6.2` is satisfied by `0.6.2` -- a real deployment
  regressed back to 2.6s+ per request from a plain `bun install` picking up
  that exact version, until the dependency was explicitly bumped further.

## [0.11.1] - 2026-09-13
### Fixed
- Bumped `@sproutboat/runtime` to `^0.6.2`, picking up a fix for a handler
  calling `.text()`/`.json()` on a `Response` built from raw wire bytes (the
  assets binding, outbound `fetch()`, or a service-binding `fetch()`) getting
  the bytes back undecoded instead of as real UTF-8 text
  (baronunread/sproutboat#181).

### Changed
- Added the 4 missing binding examples (`analytics`, `outbound-fetch`,
  `ratelimit`, `vars-secrets`) referenced live by the site's bindings page,
  and wired them into `examples/smoke.ts`.
- Corrected `vars-secrets`' doc comment: a standalone binary does not refuse
  to start when a declared secret is missing; it starts fine and only throws
  on first use of the missing secret.

## [0.11.0] - 2026-09-13
### Added
- `sproutboat toolchain doctor [--json]`: reports the whole toolchain's state
  at a glance — Zig, Porffor, SQLite, BearSSL, and uWebSockets
  versions/paths/presence, plus C compiler/archiver/SDK prerequisites.
- Self-contained platform packages (baronunread/sproutboat#134, #166):
  `@sproutboat/cli-<os>-<arch>` now ships a vendored, sha256-verified Zig
  archive and the patched Porffor source alongside the native binary. A fresh
  install's first build needs no network for either.
- `optionalDependencies` restored on the root package: `npm install
  sproutboat` resolves the real native binary for your platform again.
- `scripts/build-cli.ts --all`: cross-compiles all four platform binaries
  from one machine, for a maintainer building a full release without
  waiting on CI.

### Fixed
- Host builds (`build --target host`, `dev`, `build --standalone`) no longer
  require a system C compiler. They prefer one when present; when none is
  found, they fall back to the vendored Zig cross-compiler targeting the
  host itself — covering uWebSockets/SQLite/BearSSL's own object compiles
  and Porffor's final link alike.
- Zig is validated right after download (confirmed to actually link the
  linux-x86_64-musl target) instead of failing unexplained mid-build.
- Native dependency caches (Zig, SQLite, BearSSL, uWebSockets) are locked
  during publication and rebuild, and keyed by compiler identity — a
  concurrent build or a stale/corrupted cache entry can no longer be
  silently reused.
- Non-ASCII Latin-1-range strings emitted as raw bytes under
  `charset=utf-8` (baronunread/sproutboat#172), fixed upstream and pulled in
  via the `@sproutboat/runtime`/`@sproutboat/toolchain` bump.
- Binary static assets and proxied bodies corrupted by the #172 fix itself
  (baronunread/sproutboat#176), fixed upstream and pulled in via the same
  bump.
- A capability check rejected any code declaring a local `process()` member,
  blocking `zod` (baronunread/sproutboat#132), fixed upstream and pulled in
  via the same bump.

### Removed
- The Bun-fallback launcher: `bin/sproutboat.cjs` no longer runs
  `src/main.ts` under `bun` when no platform binary is installed — the
  platform binaries are guaranteed present now that they're published and
  self-contained.

### Docs
- `docs/standalone.md`: documents the `toISOString()`-after-async-resume
  livelock (baronunread/sproutboat#168) and its `Date.now()` workaround;
  corrects an earlier note that wrongly called it `Date`-specific.
- Release provenance notices published alongside toolchain diagnostics.

## [0.10.3] - 2026-09-11
### Added
- Rate-limiter result carries `resetAt`: `env.<NAME>.limit({ key })` now returns
  `{ success, resetAt }`, where `resetAt` is epoch ms for when the fixed window
  rolls, so a `429` can send an accurate `Retry-After`
  (baronunread/sproutboat#69). Additive; callers reading only `success` are
  unaffected.

### Changed
- `@sproutboat/runtime` and `@sproutboat/wire` bumped to `^0.5.0`; they carry
  the `resetAt` value the rate-limiter type now declares.

### Docs
- `docs/standalone.md`: dropped the stale "outbound `fetch()` speaks `http://`
  only" bullet. Standalone binaries link BearSSL and verify HTTPS against the
  Mozilla root set (see "TLS, in both directions"). Added a
  dev/standalone/deployed parity note: every binding op, rate limiters and
  `request.cf.clientIp` with `SB_TRUSTED_PROXIES` included, behaves the same
  under `sproutboat dev` as in a standalone binary and a deployed sprout.
- `capability-http-sync-v0.md`: documented async handlers. `fetch` may return a
  promise it creates (not a `.then()`-chained one, which hangs); async responses
  omit `x-sb-cpu-ms`; `crypto.subtle` digest/sign/verify are async in signature
  only over synchronous inline C, so per-request hashing costs no I/O.

## [0.10.2] - 2026-09-11
### Fixed
- The one-time Zig download no longer depends on ziglang.org being reachable.
  It now pulls from a random Zig community mirror, with ziglang.org kept only
  as a last resort, and tries the mirrors in turn on failure. ziglang.org
  rate-limits the multi-megabyte tarballs and had been timing out mid-build,
  with no fallback (baronunread/sproutboat#166). The archive sha256 is still
  enforced whatever the source. `SPROUTBOAT_ZIG_URL` overrides the source;
  `SPROUTBOAT_ZIG` still points at a prebuilt binary.
- A leftover `~/.cache/sproutboat/zig-<version>/` directory from an earlier
  cache layout is removed on the next build instead of sitting unused.

## [0.10.1] - 2026-09-11
### Fixed
- `npm install sproutboat` / `bunx sproutboat` work again. 0.10.0's launcher
  hard-required per-platform `@sproutboat/cli-*` packages that are not published
  yet, so it always failed with "optional package … is missing". The launcher
  now falls back to running `src/main.ts` with Bun when no platform binary is
  installed (the v0.9.0 model), and `optionalDependencies` are dropped until the
  binaries actually ship. 0.10.0 is deprecated on npm.
- `sproutboat --version` and the deploy banner report the real version instead
  of a hard-coded `0.9.0` when run from the npm package rather than a
  `bun build --compile` binary.
- `sproutboat build` / `deploy` locate `esbuild` via the installed dependency,
  not just `process.execPath`'s directory, so bundling works on the Bun
  fallback path.
- The launcher no longer hangs when it receives `SIGINT` / `SIGTERM` while
  forwarding a signal to a running platform binary.

## [0.10.0] - 2026-09-11
### Added
- Per-platform native CLI: `npm install sproutboat` pulls a prebuilt binary for
  the host (`@sproutboat/cli-{darwin,linux}-{arm64,x64}`) behind a thin launcher
  that preserves signals and embeds its own version, so the CLI runs without Bun
  on `PATH`.
- Porffor is fetched on the first build, not installed as a dependency: the
  pinned commit is downloaded into `~/.cache/sproutboat`, SHA-256 verified, and
  patched there. Installation clones nothing and runs no Git, Make or compiler.
- `request.cf.clientIp` in standalone builds, from a server-set
  `x-sb-remote-addr`, with `SB_TRUSTED_PROXIES` for `X-Forwarded-For` resolution
  behind a reverse proxy (baronunread/sproutboat#163).
- `env.<D1>.backup(name?)` — an online, integrity-checked single-file snapshot
  of a D1 database via `VACUUM INTO`, on both the embedded and broker transports
  (baronunread/sproutboat#164).
- Rate Limiting binding: `ratelimiters: [{ binding, limit, period }]` in
  `sproutboat.jsonc` gives `env.<NAME>.limit({ key }) -> { success }`, a
  fixed-window counter on both transports (baronunread/sproutboat#69).
- `crypto.subtle` subset: `digest` (SHA-256/384/512) and HMAC
  `importKey` / `sign` / `verify`, backed by reference SHA-2 as inline C so it
  works on both transports (baronunread/sproutboat#133). No ECDSA or AES yet.
- `crypto.scryptVerify(password, salt, expected, { N, r, p })` — a verify-only
  scrypt (RFC 7914) for migrating password hashes made by Node/Bun `scrypt`
  (baronunread/sproutboat#153). Not a blessed KDF for new credentials.
- `x-sb-cpu-ms`: per-invocation CPU time, carried on the handler response.

### Fixed
- `303` (and every other status not in Porffor's table) no longer resets the
  connection on standalone builds (baronunread/sproutboat#156).
- Handler `console.log` / `console.error` reach stderr, unbuffered, in
  standalone builds instead of vanishing (baronunread/sproutboat#165).
- `sproutboat dev` no longer leaves the previous sprout running across a
  rebuild, delivers no triggers to a candidate that failed to start, and cleans
  up every failed setup path on rebuild and on shutdown.
- The Zig toolchain cache is hardened against a partial or concurrent download.

### Changed
- Porffor pin bumped alpha-4 → **alpha-5** (`1f4ae4ae`); the same `UWS_COMMIT`,
  so no uWebSockets re-vendor.
- Config parsing, the artifact manifest, the binding broker, the wire assets and
  the whole native-fetch runtime (prelude + transports) now come from published
  `@sproutboat/*` packages; the CLI keeps thin re-export shims. The Porffor pin
  and its source patches moved to `@sproutboat/toolchain`.
- Broker cron / queue / alarm delivery is gated by a local signal, so only a
  promoted candidate runs timers.

### Performance
- Embedded transport caches prepared statements per database (FIFO, 32/db)
  instead of recompiling the SQL on every binding op — the op boundary drops
  from ~0.6 ms to tens of µs (baronunread/sproutboat#155).
- The broker's due-queue and due-alarm polls are indexed.

### Docs
- `docs/standalone.md` documents the single-threaded execution model and the
  `SO_REUSEPORT` multi-process recipe for scaling past one core
  (baronunread/sproutboat#154); the embedded transport also sets
  `PRAGMA busy_timeout` so shared-data-dir writers wait instead of failing.
  Also: the client-IP behaviour and backing up D1.

## [0.9.0] - 2026-09-07
### Added
- KV content management: `kv key get`, `put`, `delete`, and `list`; bounded
  `kv bulk get`, `put`, and `delete`; and cursor-paginated `kv export` files
  that can be restored with `kv bulk put`.
- CLI integration coverage for pagination, bounded batches, text and file
  output, overwrite refusal, and cleanup after failed exports.
- `sproutboat-env.d.ts` generation from project bindings.
- Focused runnable examples for every supported binding.

### Fixed
- Static assets keep arbitrary binary bytes when they travel through the broker.
- KV exports use a permission-restricted temporary file and move into place only
  after a complete export. Failed exports leave neither partial output nor a
  temporary file behind.
- First-host builds no longer require Git or Make.

### Changed
- Development binaries compile with Porffor `-O0` for faster iteration.
- The installation docs state that the CLI requires Bun and should be invoked
  with `bunx` rather than `npx`.

## [0.8.0] — 2026-09-07
### Added
- `sproutboat build --standalone`: one executable that carries its own bindings.
  SQLite is compiled into the sprout, so a ~2 MB file serves KV, D1, R2, queues,
  Durable Objects, alarms, analytics and assets with nothing beside it on disk —
  no Bun, no broker, no control plane. State lives in `<name>.data/store.sqlite`
  plus `d1/<binding>.sqlite`, the same layout `sproutboat dev` writes, which is
  what lets one conformance suite hold both backends to the same behaviour.
  Secrets come from the environment (then `<data>/secrets.json`) and a missing
  one refuses the boot, listing every name at once, rather than throwing on the
  first request that needs it. Cron ticks, queue batches and DO alarms run on
  in-process timers; assets are baked in, capped at 8 MB.
- Outbound TLS from a standalone binary. `fetch("https://…")` verifies against
  curl's Mozilla-derived root set via BearSSL, linked in beside SQLite
  (1.86 → 2.02 MB). `SB_CA_BUNDLE` adds a private or corporate CA to that set;
  it only ever adds trust, and nothing disables verification.
- Durable Object alarms: `setAlarm` / `getAlarm` / `deleteAlarm` and the
  `alarm()` handler. At most one alarm is pending per object and a later
  `setAlarm` replaces it, matching Workers. Delivery claims before running, so
  an `alarm()` that schedules its own next run is not erased by the delivery
  that invoked it.
- Service bindings: `env.<BINDING>.fetch()` reaches another deployment on the
  same node through the edge on loopback. This is the CLI half; a binding that
  resolves to nothing reports the target as undeployed rather than failing as a
  502.
- Binary values in the binding frame. An R2 object body now travels beside the
  JSON rather than encoded inside it.
- `SB_FETCH_MAX_BYTES` (32 MiB default) caps an outbound response body. An
  unbounded upstream could previously drive a sprout's memory to whatever it
  chose to send.

### Fixed
- `d1.exec` ran only the first statement of a multi-statement script, so a
  schema built in one `exec()` call silently created only its first table.
- `r2.get` / `head` / `put` / `list` returned flat fields where the shim reads
  `r.object`, and `ae.query` omitted the `count` its caller reads.
- Trigger authentication accepted *any* caller when no token was configured.
  The hole predates this release; a standalone binary listening on a public
  interface is what made it reachable.
- Binary R2 values were corrupted in transit — `0x08` and `0x0c` arrived as
  `b` and `f`.
- A retried binding call could apply a write twice. Every request now carries an
  id and the broker replays the cached reply for a repeat of a mutating op
  instead of performing it again.

### Changed
- A dropped broker connection is retried four times with 0/5/25/100 ms backoff
  instead of failing after one attempt, which covers a broker restart mid-call.
- The bundled (Bun) standalone backend is gone. The embedded one passes the same
  suite at 1.9 MB against 63 MB, and TLS removed its last real advantage.
- A native-fetch binary cannot see `argv` — Porffor's runtime init calls
  `porf_init(0, NULL)` — so a standalone binary is configured through `PORT`,
  `SB_DATA_DIR` / `SPROUTBOAT_DATA` and the environment only, never flags.

### Performance
- An 8 MB R2 put through the broker went from 255 MB to 149 MB peak RSS.
- The broker's frame reader no longer re-concatenates its buffer per chunk.

## [0.7.0] — 2026-09-06
### Added
- `compatibility_date` now reaches the artifact instead of being validated and
  dropped. It is recorded in `manifest.json` as `compatibilityDate` and baked
  into the binary as `__sbCompat`, so a future runtime change can be gated on
  `__sbCompat >= "YYYY-MM-DD"` and old binaries keep the semantics they were
  compiled with. The manifest field is optional and `schemaVersion` stays at 2,
  so artifacts built before this release remain deployable and rollback keeps
  working.
- A version-skew warning. Control planes advertise `x-sproutboat-control` and
  `x-sproutboat-min-cli` on every `/api/` response; when this CLI is below the
  advertised minimum it says so once per run, instead of leaving the user with
  an unexplained 400. A control plane that predates the handshake sends no
  headers and nothing changes.
- `CONTRACTS.md`, generated from source in the same style as `SURFACE.md`: the
  broker ops, storage tables, manifest fields and config keys that a release may
  not break, plus golden fixtures for the manifest and the storage format so a
  regression fails a test rather than a user's deployment.

## [0.6.1] — 2026-09-06
### Fixed
- `sproutboat queues` help (and the generated `SURFACE.md`) claimed queue
  consumers "are not implemented yet". They are implemented, and they run on
  the deployed path as well as under `dev`: the supervisor passes
  `--sprout-url` to the broker, which delivers messages in batches, retries a
  failed or explicitly-retried message after 5s, and stops delivering it after
  5 attempts. The summary now describes what actually happens.

### Changed
- Tooling only, no change to how the CLI behaves: oxfmt is scoped to the JS
  family with the pre-commit hook's glob matched to it, TypeScript moves
  5.9 → 7.0, and the GitHub Actions group is bumped.

## [0.6.0] — 2026-09-05
### Added
- `bindings.json` now carries `vars` — the baked plain values a sprout was
  built with — so the control plane can show what a version was compiled
  against. They ride along for display only; the broker never serves them,
  they are compiled into the sprout itself. A project whose only binding
  config is `vars` now gets a sidecar written at all, where before it got
  none.

### Changed
- Tooling only, no change to how the CLI behaves: the tree is now formatted
  with oxfmt 0.66.0 (the config landed in 0.5.0 but was never run over the
  tree), markdown is excluded from formatting, a lefthook pre-commit hook
  formats staged files and lints, the last 10 oxlint warnings are cleared,
  and CI gates lint alongside typecheck and test.
- README rewritten shorter: a logo lockup that survives both GitHub themes
  (`docs/logo-light.svg` / `docs/logo-dark.svg` behind a `<picture>`), the
  everyday commands as a five-row table, and the full command inventory left
  to the generated `SURFACE.md` instead of duplicated by hand.

## [0.5.0] — 2026-09-03
### Added
- `dev [--port <n>] [--no-watch]` — run the project on this machine against a
  real broker (KV/D1/secrets/etc. all work), rebuilding on save.
- `build --target host` — compile for the machine doing the build instead of
  cross-compiling for a box; what `dev` uses, and runnable standalone.
- Handlers may now `import` — relative modules across the project, and npm
  packages from the project's own `node_modules`. The entry point is bundled
  before it reaches Porffor; the capability checks run against that bundled
  output, so a dependency can't reach `process`/`Bun`/`node:*` any more than
  hand-written code can.
- `sproutboat init` scaffolds a `.gitignore` (`.sproutboat/`, `.dev.vars`,
  `node_modules/`) alongside the project files, unless one already exists.

### Fixed
- Async `fetch` handlers hung indefinitely — `__sbEntry` chained the #28
  CPU-time tag onto the handler's own promise, and Porffor's native-fetch
  server only resolves a promise a handler returns directly, never one
  derived from `.then()`.
- `new Proxy(...)` compiles under Porffor alpha-4 and then silently ignores
  every trap — a trapped property just reads back `undefined`. `check` now
  rejects it before that reaches a deploy as an unexplained 502.
- `sproutboat init` crashed with a raw `EEXIST` stack trace, and could leave
  a half-scaffolded project, if `src/index.js` already existed but
  `sproutboat.jsonc` didn't. Both targets are checked before either is
  written.
- Re-running `sproutboat build` (or `dev`'s rebuild-on-save) could fail to
  link: the artifact directory is content-addressed, so an unchanged rebuild
  targeted the previous binary, which was `chmod 0555` and possibly still
  running.
- The broker's local dev state directory was never created before opening
  its SQLite file, so a first `sproutboat dev` run failed outright.

### Changed
- Lint: adopted the anti-slop Oxlint plugin and migrated the tree onto it —
  no more bare `unknown`/`Record<string, unknown>` at binding boundaries,
  every non-const type assertion carries a `SAFETY:` comment.

## [0.4.11] — 2026-09-02
### Changed
- README rewritten for current commands and config; points at the docs site.

## [0.4.10] — 2026-09-02
### Changed
- `domains`: prints the A record to add, and any DNS reachability warning.

## [0.4.9] — 2026-09-02
### Changed
- `deploy` (#80): dropped the client-side dedup check in favour of trusting
  the server's own no-op response.

## [0.4.8] — 2026-09-02
### Fixed
- `deploy` (#80): no longer skipped the upload when only assets or bindings
  had changed but the sprout binary hadn't.

## [0.4.7] — 2026-09-02
### Added
- `deploy` auto-provisions an id-less storage binding (wrangler-style):
  creates the account-level resource, writes its id back into
  `sproutboat.jsonc`.

## [0.4.6] — 2026-09-02
### Added
- `sproutboat resource` — manage account-level storage resources directly.
- `sproutboat.jsonc` storage bindings accept `{ binding, id }`, not just a
  bare name.
### Changed
- Broker keys KV/R2/queue/D1 stores by resource id when one is bound, so the
  data survives a redeploy and can be shared across projects.

## [0.4.5] — 2026-09-02
### Changed
- `deploy` dropped the "✓ serving" line — silence now means the health check
  passed.

## [0.4.4] — 2026-09-02
### Added
- `--version`, a once-a-day update-available notice, a richer deploy echo.
### Changed
- Misuse now exits `2` (getopt convention) instead of `1`.

## [0.4.3] — 2026-09-02
### Changed
- `--help` output: grouped, emoji-labelled, aligned — was one wall-of-text
  usage line.

## [0.4.2] — 2026-09-02
### Added
- `tail --sprout` streams the running sprout's and broker's stdout/stderr.
### Changed
- `deploy` waits for the health check and prints every binding in the
  report; `delete` takes flexible args plus `?confirm`; the banner reads the
  real installed version.

## [0.4.0] — 2026-09-01
### Added
- `sproutboat domains` and `sproutboat secrets` commands.
- `deploy` uploads the `bindings.json` / `assets.json` sidecars alongside
  the sprout binary.
- The worker self-reports per-invocation CPU time (`x-sb-cpu-ms`).
- Deploy surfaces a Porffor pin drift warning when the live version was
  built against a different compiler pin than the one about to deploy.
### Changed
- Renamed "worker" to "sprout" throughout the CLI, broker, and examples.

## [0.3.0] — 2026-09-01
### Added
- Published to npm via Trusted Publishing (OIDC) — no token secret in CI.
### Changed
- `src/wrap.ts` extracted with `runtime/*` subpath exports, so the monorepo
  can consume the binding/manifest contracts as a dependency instead of a
  hand-vendored copy.
- CSPRNG-backed `crypto.getRandomValues`; the deploy binary is stripped.
- One long-lived broker connection per worker instead of reconnecting on
  every binding call; `env.<SECRET>` memoized; `assets.get` made synchronous
  with the broker service; WAL + `synchronous=NORMAL` and parameterised
  `LIMIT` back-ported from the monorepo's broker.

## [0.2.1] — 2026-08-31
### Changed
- Ships a prebuilt uWebSockets archive, so the first build needs neither
  `git` nor `make` on `PATH`.

## [0.2.0] — 2026-08-31
Initial release, extracted from the `sproutboat` monorepo (`apps/cli`) as
its own package.
### Added
- Cross-compiles a handler to a static `linux-x86_64` binary with Porffor +
  Zig — no Docker.
- Static assets binding, with the `examples/kitchen-sink` Astro app as a
  worked example.
- `SURFACE.md`, generated and drift-checked against the actual command/env
  surface.
### Changed
- Patches Porffor at build time rather than via a `postinstall` hook.
- Renamed the package to `sproutboat` (was `@sproutboat/cli`); dropped the
  `sprout` bin alias in favour of a user-defined shell alias.

[Unreleased]: https://github.com/baronunread/sproutboat-cli/compare/v0.32.0...HEAD
[0.32.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.30.0...v0.31.0
[0.24.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.23.0...v0.24.0
[0.19.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.7...v0.13.0
[0.12.7]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.6...v0.12.7
[0.12.6]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.5...v0.12.6
[0.12.5]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.4...v0.12.5
[0.12.4]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.3...v0.12.4
[0.12.3]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/baronunread/sproutboat-cli/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.13...v0.12.0
[0.11.13]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.12...v0.11.13
[0.11.12]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.11...v0.11.12
[0.11.11]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.10...v0.11.11
[0.11.10]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.9...v0.11.10
[0.11.9]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.8...v0.11.9
[0.11.8]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.7...v0.11.8
[0.11.7]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.6...v0.11.7
[0.11.6]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.5...v0.11.6
[0.11.5]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.4...v0.11.5
[0.11.4]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.3...v0.11.4
[0.11.3]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/baronunread/sproutboat-cli/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.10.3...v0.11.0
[0.10.3]: https://github.com/baronunread/sproutboat-cli/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/baronunread/sproutboat-cli/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/baronunread/sproutboat-cli/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/baronunread/sproutboat-cli/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.11...v0.5.0
[0.4.11]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.10...v0.4.11
[0.4.10]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.9...v0.4.10
[0.4.9]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/baronunread/sproutboat-cli/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/baronunread/sproutboat-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/baronunread/sproutboat-cli/releases/tag/v0.2.0
