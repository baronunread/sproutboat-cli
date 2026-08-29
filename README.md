# sproutboat-cli

The Wrangler-shaped CLI for [Sproutboat](https://github.com/baronunread/sproutboat).
**MIT licensed** (the platform itself is not).

It speaks only the documented `/api` HTTP contract, so the same binary targets a
**self-hosted** instance or the **cloud** — you point it at a control-plane URL:

```sh
bunx @sproutboat/cli login --api-url https://control.example.com --token <token>
# or per-invocation, for CI:
export SPROUTBOAT_API_URL=https://control.example.com SPROUTBOAT_TOKEN=<token>

sproutboat init hello
sproutboat deploy --dry-run   # Wrangler-style report, no upload
sproutboat deploy
sproutboat tail hello
sproutboat versions list hello
sproutboat rollback <id>
sproutboat delete --yes
```

Credentials are keyed by API URL in `~/.config/sproutboat/credentials.json`, so
you can hold logins for several instances at once.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Docker — `sproutboat build`/`deploy` cross-compile the handler inside a pinned
  Porffor toolchain image, published to GHCR by CI
  (`ghcr.io/baronunread/sproutboat/build:latest`). It is pulled once on first
  build. Overrides:
  - `SPROUTBOAT_BUILD_IMAGE_REF` — use a different image ref
  - `SPROUTBOAT_BUILD_IMAGE` — pin an immutable `...@sha256:` digest
  - `SB_GHCR_TOKEN` — token for `docker login ghcr.io` if the package is private

## Commands

| Command | What it does |
| --- | --- |
| `init [name]` | Scaffold `sproutboat.jsonc` + `src/index.js` |
| `check` | Validate config + entry point without building |
| `build` | Cross-compile the native-fetch server artifact |
| `deploy [--dry-run] [--artifact <dir>]` | Build (unless `--artifact`), print the report, upload |
| `login [--api-url <url>] [--token <token>]` | Browser device flow, or store a token directly |
| `tail` | Recent logs for the project |
| `versions list` | Deployed versions |
| `rollback <id>` | Activate a previous version |
| `delete --yes` | Delete the project |

## Status

**Migrated.** This is the canonical source. See [MIGRATION.md](MIGRATION.md) for
how it maps back to the monorepo.
