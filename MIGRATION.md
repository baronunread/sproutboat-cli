# CLI ↔ monorepo mapping

The CLI was extracted from `sproutboat/apps/cli` on 2026-08-29. It is now the
canonical source; the monorepo copy is kept in sync by hand until the shared
pieces are published as `@sproutboat/*` packages.

## Files vendored from the monorepo

| Here | From the monorepo |
| --- | --- |
| `src/main.ts` | `apps/cli/src/main.ts` |
| `src/credentials.ts` | `apps/cli/src/credentials.ts` |
| `src/report.ts` + `src/report.test.ts` | `apps/cli/src/report.ts` (+ test) |
| `src/config.ts` | `packages/config/src/config.ts` |
| `src/source.ts` | `packages/config/src/source.ts` |
| `src/manifest.ts` | `packages/artifact/src/manifest.ts` |
| `src/native-fetch-prelude.js` | `tools/native-fetch-prelude.js` (verbatim) |
| `src/assets.ts` | `tools/assets.ts` + `services/broker/src/assets.ts` (verbatim) |
| `src/broker.ts` | `services/broker/src/broker.ts` (verbatim) |

The only change on import is rewriting the monorepo's relative
`../../../packages/...` paths to local `./` imports.

## What diverged from the monorepo

The monorepo compiles inside a **Docker toolchain image**
(`packages/artifact/src/build.ts` → `docker run ghcr.io/.../build`). This repo
does **not** — it runs Porffor directly and cross-compiles with Zig:

| Here | Replaces |
| --- | --- |
| `src/build.ts` | monorepo `packages/artifact/src/build.ts` (no `docker`, no `buildImage()` / GHCR) |
| `src/compile.ts` | monorepo `tools/compile.ts` (`wrapNativeFetchHandler` verbatim; adds `--musl`) |
| `src/toolchain.ts` | monorepo `tools/porffor.ts` + `build-image/`: pins Zig, downloads it, stamps provenance |
| `src/patch-porffor.ts` | monorepo `tools/patch-porffor.ts` + `patches/porffor-render.patch`: now a 2-line in-JS edit of `render.js` (adds the `$PORT` runtime read), applied from the build path. Not a `postinstall` hook: package managers block dependency lifecycle scripts by default, so a published one would silently not run. No `patch` binary needed. See `patches/UPSTREAM.md`. |

Consequences:

- **No local smoke test.** The Docker path ran the fresh binary and curled it.
  A non-linux build host can't, so `build.ts` skips it; the control plane starts
  the binary on deploy and rejects it if it doesn't come up.
- `manifest.buildImage` now holds a toolchain stamp
  (`zig-musl/<zig>+porffor/<commit>+uws/<commit>`), not an image digest. The
  field name is unchanged to keep the manifest schema at v2.
- `dev` (local edge server) is dropped — it needs `services/edge`.
- **Bindings** were built here first (this repo is canonical for the
  prelude / compile / config) and vendored back to the monorepo:
  - `src/config.ts`: `kv_namespaces` / `secrets` / `outbound` / `d1_databases` /
    `r2_buckets` / `queues` / `analytics_engine_datasets` / `durable_objects` /
    `triggers` fields + validation. → monorepo `packages/config/src/config.ts`
    (verbatim).
  - `src/source.ts`: `fetch(` allowed when `outbound` is set; the default-export
    check is no longer anchored to the file start (DO classes may precede it). →
    monorepo `packages/config/src/source.ts` (verbatim).
  - `src/native-fetch-prelude.js`: inline-C broker transport + `__sbEnv`,
    `__sbInstallBindings` (KV / secret / D1 / R2 / queue producer / Analytics
    Engine / Durable Object namespace + storage), the DO instance registry, and
    `__sbEntry` (routes `x-sb-trigger: scheduled|queue` to the user handlers). →
    monorepo `tools/native-fetch-prelude.js` (verbatim; lint-excluded there).
  - `src/compile.ts`: `wrapNativeFetchHandler` neutralises the module's `export`
    keywords (`export default` → `__sbHandlers`, `export class/function/const` →
    plain), emits `__sbInstallBindings` + `__sbRegisterDO`, and wraps everything
    in one `export default { fetch }` that calls `__sbEntry`. `Bindings` =
    `{kv,secrets,outbound,d1,r2,queues,analytics,do,crons}`. → monorepo
    `tools/compile.ts` gains the same `wrapNativeFetchHandler` + `Bindings` +
    `readBindingsFromEnv` (reads `SPROUTBOAT_BINDINGS_JSON`).
  - `src/build.ts`: writes `bindings.json` beside `manifest.json` (kept out of
    the frozen-v2 manifest).
  - `src/broker.ts`: the host-side broker (Bun + SQLite). Ops: `ping`, `kv.*`,
    `secret.get`, `fetch`, `d1.query|batch|exec`, `r2.*`, `queue.send|send_batch`,
    `ae.write`, `do.storage.*`. With `--worker-url` set it also runs the cron
    scheduler (`cronMatches`) and the queue consumer. → copied verbatim to
    monorepo `services/broker/src/broker.ts` (`broker.test.ts` stays here as the
    test of record). Monorepo `services/supervisor/src/run.ts` now spawns one
    broker per deployment that ships a `bindings.json`, passing `SB_BROKER_PORT` /
    `SB_BROKER_TOKEN` to the worker and `--worker-url` / `--data-dir` to the
    broker; secrets come from a `secrets.json` next to the artifact (the control
    plane must write it — encryption at rest is `baronunread/sproutboat#8`).
  - `examples/kitchen-sink/`: one app using every binding: `src/index.js`
    (worker), `web/` (an Astro UI, built to `web/dist` and published as
    `env.ASSETS`), `harness.ts` (`bun run example:kitchen-sink`, 18 checks),
    `serve.ts` (stays up for the browser), `build-web.ts` (shared astro-build
    step). **Also copied to `sproutboat/examples/kitchen-sink/`** — same app
    files, but `harness.ts` / `serve.ts` import the monorepo's own modules
    (`tools/compile`, `packages/config`, `services/broker`, `tools/assets`) so it
    is an integration test of the platform code. `examples/**` is oxlint-ignored
    there; `web/{dist,node_modules}` are gitignored in both.
  - `src/build.ts`: `bindings.json` gains `d1` / `r2` name lists.
  - **Static assets** (`assets` config block) — `src/assets.ts` (`walkAssets`,
    `contentType`, `isSproutFirst` glob) → `tools/assets.ts` +
    `services/broker/src/assets.ts` (verbatim). `src/build.ts` copies the dir to
    `assets/` next to the artifact and writes `assets.json`. `Bindings` gains
    `assets` (binding name or `""`); the prelude adds `env.<ASSETS>.fetch` →
    broker `assets.get` (`--assets-dir`, applies `not_found_handling`). Monorepo
    `services/edge/src/main.ts` serves exact matches assets-first (respecting
    `run_sprout_first`); `services/supervisor/src/run.ts` passes `--assets-dir`
    when `assets.json` is present.

## Pinned versions (bump together)

- `src/toolchain.ts`: `ZIG_VERSION` + its `ZIG_SHA256` table, and
  `PORFFOR_CHANNEL` / `PORFFOR_COMMIT` (must match `porffor` in `package.json`).
- `package.json`: `porffor` (`github:CanadaHonk/porffor#alpha-4`), `esbuild`.

## Keeping in sync

When the vendored files change in the monorepo, copy them over and re-run the
import rewrite. When they stabilise, publish `@sproutboat/config` +
`@sproutboat/artifact` and depend on them instead.
