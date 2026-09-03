# Changelog

All notable changes to `sproutboat` (the CLI) are documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/), pre-1.0 so a minor bump can still carry
a breaking change.

Reconstructed from git history on 2026-09-03 for everything through v0.4.11;
maintained going forward by the `release` skill.

## [Unreleased]

On `wrangler-shaped` (PR [#6](https://github.com/baronunread/sproutboat-cli/pull/6)).

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

[Unreleased]: https://github.com/baronunread/sproutboat-cli/compare/v0.4.11...HEAD
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
