# sproutboat

The CLI for [Sproutboat](https://github.com/baronunread/sproutboat) — a
Wrangler-shaped tool for deploying workers to any Sproutboat control plane.
MIT licensed.

```sh
bunx sproutboat login --api-url https://control.example.com
bunx sproutboat init hello
cd hello
bunx sproutboat deploy
```

Or install it once and drop the `bunx`:

```sh
bun add -g sproutboat     # then: sproutboat deploy, sproutboat tail, ...
```

Want it shorter? Alias it yourself: `alias sprout='sproutboat'`.

For CI, skip `login` and set `SPROUTBOAT_API_URL` + `SPROUTBOAT_TOKEN`.

## Commands

| Command | What it does |
| --- | --- |
| `init [name]` | Scaffold `sproutboat.jsonc` + `src/index.js` |
| `check` | Validate the config and entry point |
| `build` | Cross-compile the worker artifact |
| `deploy [--dry-run] [--artifact <dir>]` | Build and upload (`--dry-run` prints the report only) |
| `login [--api-url <url>] [--token <token>]` | Browser device flow, or store a token |
| `tail [name]` | Recent logs |
| `versions list [name]` | Deployed versions |
| `rollback <id>` | Activate a previous version |
| `delete --yes` | Delete the project |

Credentials are keyed by API URL in `~/.config/sproutboat/credentials.json`, so
you can hold logins for several instances at once.

## Config

`sproutboat.jsonc` — the entry point plus Cloudflare-shaped `env.*` bindings:

```jsonc
{
  "name": "app",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26",

  "vars": { "SITE": "hi" },
  "secrets": ["API_KEY"],
  "kv_namespaces": ["CACHE"],
  "d1_databases": ["DB"],
  "r2_buckets": ["UPLOADS"],
  "queues": ["JOBS"],
  "analytics_engine_datasets": ["METRICS"],
  "durable_objects": { "COUNTER": "Counter" },
  "outbound": ["api.example.com"],
  "triggers": { "crons": ["*/5 * * * *"] },
  "assets": { "directory": "public", "binding": "ASSETS" }
}
```

The handler is one `export default { fetch }`, optionally with `scheduled` /
`queue` handlers and exported Durable Object classes. See
[`examples/kitchen-sink/`](examples/kitchen-sink) for one app that uses every
binding, with an Astro UI and a runnable end-to-end harness.

## Requirements

- [Bun](https://bun.sh) 1.4+

`build` / `deploy` cross-compile the handler to a static `linux-x86_64` binary
with Porffor and Zig (Zig is fetched automatically on first use). The package
ships a prebuilt uWebSockets, so nothing else is compiled from source. No Docker,
no root. On Windows, build from WSL.

If that prebuilt is unusable (a `porffor` pin bump before the archive is
refreshed), the first build falls back to compiling uWebSockets locally, which
needs `git` and `make` on `PATH`. `SPROUTBOAT_UWS_TARBALL=<archive>` overrides
the shipped one.

## Limits (v1)

Binding values are text/JSON and travel one at a time over a loopback frame; an
upload is capped at 1 MiB by the worker's HTTP server (large-object R2 is
[#56](https://github.com/baronunread/sproutboat/issues/56)). No WebSockets yet.

---

Contributors: [`MIGRATION.md`](MIGRATION.md) maps this repo back to the monorepo.
[`SURFACE.md`](SURFACE.md) is a generated inventory of every command and env var.
