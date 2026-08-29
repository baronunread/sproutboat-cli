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
| `src/toolchain.ts` | monorepo `tools/porffor.ts` + `build-image/` — pins Zig, downloads it, stamps provenance |
| `src/patch-porffor.ts` | monorepo `tools/patch-porffor.ts` + `patches/porffor-render.patch` — now a 2-line in-JS edit of `render.js` (adds the `$PORT` runtime read), applied from the build path. Not a `postinstall` hook: package managers block dependency lifecycle scripts by default, so a published one would silently not run. No `patch` binary needed. See `patches/UPSTREAM.md`. |

Consequences:

- **No local smoke test.** The Docker path ran the fresh binary and curled it.
  A non-linux build host can't, so `build.ts` skips it; the control plane starts
  the binary on deploy and rejects it if it doesn't come up.
- `manifest.buildImage` now holds a toolchain stamp
  (`zig-musl/<zig>+porffor/<commit>+uws/<commit>`), not an image digest. The
  field name is unchanged to keep the manifest schema at v2.
- `dev` (local edge server) is dropped — it needs `services/edge`.

## Pinned versions (bump together)

- `src/toolchain.ts` — `ZIG_VERSION` + its `ZIG_SHA256` table, and
  `PORFFOR_CHANNEL` / `PORFFOR_COMMIT` (must match `porffor` in `package.json`).
- `package.json` — `porffor` (`github:CanadaHonk/porffor#alpha-4`), `esbuild`.

## Keeping in sync

When the vendored files change in the monorepo, copy them over and re-run the
import rewrite. When they stabilise, publish `@sproutboat/config` +
`@sproutboat/artifact` and depend on them instead.
