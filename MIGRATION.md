# CLI ↔ monorepo boundary

The CLI was extracted from `sproutboat/apps/cli` on 2026-08-29 and is the
canonical source for the shared runtime surface. As of 2026-09-01 the monorepo
**depends on this package** — `"sproutboat": "github:baronunread/sproutboat-cli#main"`,
pinned to a resolved commit by its `bun.lock` — instead of hand-copying files.
Nothing is vendored any more.

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

The prelude and transports are not exported: they live in `@sproutboat/runtime`
(next to `wrap.ts`, which resolves them by file URL). Read them as text via
`preludePath` / `transportPath` from `./runtime/wrap`.

Each export points at a raw `.ts`; there is no build step
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

The monorepo's `bun.lock` pins a resolved `sproutboat-cli` commit. Push the CLI
change, then `cd ../sproutboat && bun update sproutboat` to move the pin, and
commit the `package.json` (unchanged) + `bun.lock` there. CI resolves the
pinned commit, so you cannot land a monorepo lockfile that points at an
unpushed CLI change.

For the inner loop, `bun link` reads the CLI working tree with no reinstall:

```sh
cd sproutboat-cli && bun link
cd ../sproutboat  && bun link sproutboat   # undo: bun unlink sproutboat && bun install
```

CI never links.

**Direction is one-way:** nothing in `sproutboat-cli/src/` may import from the
monorepo. The CLI is the library; the monorepo is its client.

## Pinned versions

- **Porffor** — one place: `@sproutboat/toolchain/src/pin.ts`
  (`PORFFOR_CHANNEL` / `PORFFOR_COMMIT_FULL` / `PORFFOR_ARCHIVE_SHA256`). The CLI
  and the monorepo both `ensurePorffor()` from that package, which fetches the
  commit into `~/.cache/sproutboat`, verifies the sha (`shasum -a 256` of
  `codeload.github.com/CanadaHonk/porffor/tar.gz/<commit>`) and applies every
  patch from `@sproutboat/toolchain/src/patch.ts`. `sproutboat-cli/src/{porffor-toolchain,patch-porffor}.ts`
  are re-export shims; the monorepo has no `porffor` npm dep and no local patch
  script any more.
- `sproutboat-cli/src/toolchain.ts`: `ZIG_VERSION` + its `ZIG_SHA256` table, and
  `UWS_COMMIT_FULL` + `UWS_TARBALL_SHA256`. When the Porffor pin moves, check
  `UWS_COMMIT` in the new `compiler/uwebsockets.js`; if it changed, rebuild the
  vendored archive via `bun tools/prebuild-uws.ts` / the `uws-prebuild` workflow.
  (alpha-4 → alpha-5 kept the same `UWS_COMMIT`, so no re-vendor.)
- `SURFACE.md` carries the provenance stamp — regenerate with `bun run surface`.

Bumping the pin: edit `pin.ts`, publish `@sproutboat/toolchain`, then
`bun update @sproutboat/toolchain` in the CLI and the monorepo, and re-run both
test + conformance suites.
