# sproutboat-cli

The Wrangler-shaped CLI for [Sproutboat](https://github.com/baronunread/sproutboat).
**MIT licensed** (the platform itself is not).

It speaks only the documented `/api` HTTP contract, so the same binary targets a
**self-hosted** instance or the **cloud** — you point it at a control-plane URL.

> Runs on **Bun** (uses `Bun.spawn`/`Bun.file`). Use `bunx`, not `npx`.

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
- `git` and `make` on `PATH` — used **once** the first time you build, to fetch
  and compile uWebSockets into `~/.cache/porffor/deps/`. Later builds reuse it.
- No Docker. `sproutboat build`/`deploy` cross-compile the handler to a static
  `linux-x86_64` binary with Porffor + [Zig](https://ziglang.org) (`zig cc
  -target x86_64-linux-musl`). Zig is fetched once to
  `~/.cache/sproutboat/zig-<version>/`.
  - `SPROUTBOAT_ZIG=/path/to/zig` — use an existing Zig instead of downloading
  - `SPROUTBOAT_COMPILE_TIMEOUT_MS` — compile timeout (default 600000)

  Windows is not supported directly — build from WSL.

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
