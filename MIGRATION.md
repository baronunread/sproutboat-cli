# CLI ↔ monorepo boundary

The CLI was extracted from `sproutboat/apps/cli` on 2026-08-29 and is the
canonical source for the shared runtime surface. As of 2026-09-01 the monorepo
**depends on this package** — `"sproutboat": "file:../sproutboat-cli"`, pinned by
its `bun.lock` — instead of hand-copying files. Nothing is vendored any more.

**If you find yourself copying a file between the two repos, add an export
instead.**

## Shared surface (`exports`)

| export | consumed by (monorepo) |
| --- | --- |
| `./runtime/config` | `tools/measure-coldstart.ts`, `tests/contracts.test.ts` |
| `./runtime/source` | `tools/check.ts`, `tests/contracts.test.ts` |
| `./runtime/manifest` | `apps/control/src/artifact.ts` |
| `./runtime/assets` | `services/edge/src/main.ts`, `tests/broker.test.ts` |
| `./runtime/broker` | spawned by `services/supervisor/src/run.ts` via `import.meta.resolve` |
| `./runtime/wrap` | `tools/compile.ts` (which re-exports it for its own importers) |
| `./runtime/prelude` | read as text via `preludePath` from `./runtime/wrap` — never imported |

Each export points at a raw `.ts` (or the `.js` prelude); there is no build step
and no `.d.ts` — the source is the types. Bun's runtime and `tsc`
(`moduleResolution: "bundler"`) both follow the map.

Adding an export is a semver-minor here and a `bun update sproutboat` there.
Changing the shape of one is a breaking change for the monorepo — its CI will
tell you.

### `src/wrap.ts`

The build-independent half of `src/compile.ts`: `wrapNativeFetchHandler`, the
`Bindings` shape / `EMPTY_BINDINGS`, `preludePath`, and the
`SPROUTBOAT_{VARS,BINDINGS}_JSON` readers. It has **no imports** so the monorepo
can use it in its own host-native compile path without pulling in `toolchain.ts`
/ `patch-porffor.ts`. `wrapNativeFetchHandler` takes an optional 5th `port` arg
(default 8080) — the monorepo's bench path overrides the baked fallback.

## Not shared, on purpose

- `src/build.ts` / `src/toolchain.ts` / `src/patch-porffor.ts` / `vendor/` —
  the Zig + musl cross-compile toolchain (downloads pinned Zig, extracts the
  vendored prebuilt uWebSockets, stamps provenance). **The self-hosted platform
  never compiles anything**: `sproutboat deploy` builds the binary locally and
  uploads `worker` + `manifest.json`; the control plane validates and stores it,
  the supervisor spawns it. No Porffor, no Zig, no Docker on the server.
- `src/main.ts` / `src/credentials.ts` / `src/report.ts` / `src/surface.ts` —
  CLI UX, no monorepo consumer. (The old `apps/cli/*` mapping is gone — that
  directory no longer exists in the monorepo.)
- The monorepo's `tools/compile.ts` (`compileHandler`) is a *different program*
  from this repo's `src/compile.ts` (`compileWorker`): host-native, no `--musl`,
  no cross-compile; it drives `tools/diff.ts`'s Porffor compat suite and the
  coldstart bench. Their shared half is `./runtime/wrap`.

## Making a change the monorepo needs

Both repos are checked out as siblings, so `file:../sproutboat-cli` resolves
directly — an edit here is visible in the monorepo with no reinstall. For a
clean-room check, `cd ../sproutboat && bun install` re-links it.

`bun link` also works for the inner loop:

```sh
cd sproutboat-cli && bun link
cd ../sproutboat  && bun link sproutboat
```

CI never links — it checks out `sproutboat-cli` as a sibling and installs the
`file:` path, so it always tests the committed CLI tree. You cannot land a
monorepo `bun.lock` that points at an unpushed CLI change.

> The CLI repo is private, so `bun`'s `github:`/`git+https:` resolver (which
> hits the unauthenticated GitHub tarball API) can't fetch it. If the repo is
> made public later, switch the monorepo dep to
> `github:baronunread/sproutboat-cli#main` — `bun.lock` still pins the resolved
> commit.

**Direction is one-way:** nothing in `sproutboat-cli/src/` may import from the
monorepo. The CLI is the library; the monorepo is its client.

## Pinned versions (bump together)

- `src/toolchain.ts`: `ZIG_VERSION` + its `ZIG_SHA256` table,
  `PORFFOR_CHANNEL` / `PORFFOR_COMMIT` (must match `porffor` in `package.json`),
  and `UWS_COMMIT_FULL` + `UWS_TARBALL_SHA256` (rebuild via
  `bun tools/prebuild-uws.ts` / the `uws-prebuild` workflow when the porffor pin
  moves).
- `package.json`: `porffor` (`github:CanadaHonk/porffor#alpha-4`), `esbuild`.

The monorepo pins `porffor` to the **same** specifier. They must stay identical
or Bun installs two Porffor checkouts.
