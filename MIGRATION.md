# Migrating the CLI out of the monorepo

The CLI in `sproutboat/apps/cli` imports shared code by relative path. Those
pieces have to be published (or vendored) before the CLI can stand alone.

## What moves here verbatim

- `apps/cli/src/main.ts`
- `apps/cli/src/credentials.ts`
- `apps/cli/package.json` (already `@sproutboat/cli`, MIT)

## What it depends on (must become `@sproutboat/*` packages)

| Import in `main.ts` | Source in monorepo | Notes |
| --- | --- | --- |
| `parseConfig` | `packages/config/src/config.ts` | pure, no deps — publish as `@sproutboat/config` |
| `validateHttpSyncSource` | `packages/config/src/source.ts` | pure — same package |
| `validateManifest`, `ArtifactManifest` | `packages/artifact/src/manifest.ts` | pure — `@sproutboat/artifact` |
| `buildArtifact` | `packages/artifact/src/build.ts` | **shells out to `docker` + reads `tools/porffor.ts`** — the heaviest dependency; needs the build-image contract to be a stable public thing |
| `porfforVersion` | `tools/porffor.ts` | reads `bun.lock` — rework to read the CLI's own lockfile or take it as input |

## Suggested order

1. Publish `@sproutboat/config` + `@sproutboat/artifact` (manifest only) from the
   monorepo — small, pure, versioned.
2. Decide the `buildArtifact` boundary: either publish `@sproutboat/build` with a
   documented build-image digest contract, or keep local builds in-monorepo and
   have the CLI call a thin `sproutboat build` shim it ships itself.
3. `git subtree split --prefix=apps/cli` from the monorepo to seed history here,
   then swap the relative imports for the published packages.
4. Wire CI (typecheck + a smoke test against a throwaway control plane).
