# Changelog

All notable changes to `sproutboat` (the CLI) are documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/), pre-1.0 so a minor bump can still carry
a breaking change.

Reconstructed from git history on 2026-09-03 for everything through v0.4.11;
maintained going forward by the `release` skill.

## [Unreleased]
### Changed
- Porffor pin bumped alpha-4 → **alpha-5** (`1f4ae4ae`). Perf and
  closure/string-allocation fixes upstream; the same `UWS_COMMIT`, so no
  uWebSockets re-vendor. All `src/patch-porffor.ts` edits still apply.

### Added
- `x-sb-remote-addr` / `request.cf.clientIp` in standalone builds, with
  `SB_TRUSTED_PROXIES` for `X-Forwarded-For` resolution behind a reverse proxy
  (baronunread/sproutboat#163).
- `env.<D1>.backup(name?)` — an online, integrity-checked single-file snapshot
  of a D1 database via `VACUUM INTO`, on both the embedded and broker transports
  (baronunread/sproutboat#164).
- Rate Limiting binding: `ratelimiters: [{ binding, limit, period }]` in
  `sproutboat.jsonc` gives `env.<NAME>.limit({ key }) -> { success }`, a
  fixed-window counter on both transports (baronunread/sproutboat#69).
- `crypto.subtle` subset: `digest` (SHA-256/384/512) and HMAC
  `importKey` / `sign` / `verify`, backed by reference SHA-2 as inline C so it
  works on both transports (baronunread/sproutboat#133). No ECDSA/AES yet.
- `crypto.scryptVerify(password, salt, expected, { N, r, p })` — a verify-only
  scrypt (RFC 7914) for migrating password hashes made by Node/Bun `scrypt`
  (baronunread/sproutboat#153). Not a blessed KDF for new credentials.

### Performance
- Embedded transport caches prepared statements per database (FIFO, 32/db)
  instead of compiling the SQL on every binding op — the op boundary drops from
  ~0.6 ms to tens of µs (baronunread/sproutboat#155).

### Docs
- `docs/standalone.md` documents the single-threaded execution model and the
  `SO_REUSEPORT` multi-process recipe for scaling past one core
  (baronunread/sproutboat#154). The embedded transport also sets
  `PRAGMA busy_timeout` so shared-data-dir writers wait instead of failing.

### Fixed
- `303` (and every other status not in Porffor's table) no longer resets the
  connection on standalone builds (baronunread/sproutboat#156).
- Handler `console.log` / `console.error` reach stderr, unbuffered, in
  standalone builds instead of vanishing (baronunread/sproutboat#165).

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

[Unreleased]: https://github.com/baronunread/sproutboat-cli/compare/v0.8.0...HEAD
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
