# CLI ↔ monorepo mapping

The CLI was extracted from `sproutboat/apps/cli` on 2026-08-29. It is now the
canonical source; the monorepo copy is kept in sync by hand until the shared
pieces are published as `@sproutboat/*` packages.

## Files vendored here

| Here | From the monorepo |
| --- | --- |
| `src/main.ts` | `apps/cli/src/main.ts` |
| `src/credentials.ts` | `apps/cli/src/credentials.ts` |
| `src/report.ts` | `apps/cli/src/report.ts` |
| `src/report.test.ts` | `apps/cli/src/report.test.ts` |
| `src/config.ts` | `packages/config/src/config.ts` |
| `src/source.ts` | `packages/config/src/source.ts` |
| `src/manifest.ts` | `packages/artifact/src/manifest.ts` |
| `src/build.ts` | `packages/artifact/src/build.ts` |

The only change on the way in is import rewriting: the monorepo's relative
`../../../packages/...` paths become local `./` imports. All eight files are
otherwise byte-identical and depend only on Bun + `docker` on `PATH`.

## Dropped from the standalone build

- `dev` — the local dev server spawns `services/edge`, which is not part of the
  CLI. Run it from the monorepo if you need it.

## Toolchain contract

`src/build.ts` reads the pinned toolchain versions from the build image itself
(`/opt/sproutboat-toolchain.json`, written by `sproutboat/build-image/Dockerfile`),
so this repo does not need the monorepo's `bun.lock` or `tools/porffor.ts`.

## Keeping in sync

When any of the eight source files change in the monorepo, copy them over and
re-run the import rewrite. When they stabilise, publish `@sproutboat/config` and
`@sproutboat/artifact` and depend on them instead.
