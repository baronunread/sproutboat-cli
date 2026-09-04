<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo-light.svg" alt="sproutboat" width="220" height="32">
</picture>

https://sproutboat.com

The CLI for [Sproutboat](https://github.com/baronunread/sproutboat). Compiles a
`fetch` handler to a native binary and ships it to any Sproutboat control plane.

## Overview

Wrangler-shaped, MIT licensed. `build` and `deploy` cross-compile your handler
to a static `linux-x86_64` binary with [Porffor](https://porffor.dev) and Zig —
no Docker, no root, nothing to run as a daemon.

Full reference: [sproutboat.com/docs](https://sproutboat.com/docs) (plain text
for agents: [sproutboat.com/llms.txt](https://sproutboat.com/llms.txt)).

## Using

```sh
bunx sproutboat init hello
cd hello
bunx sproutboat dev        # runs it right here, no control plane needed
```

Happy with it? Ship it:

```sh
bunx sproutboat login --api-url https://control.example.com   # one browser approval
bunx sproutboat deploy
```

Or install it once and drop the `bunx`:

```sh
bun add -g sproutboat     # then: sproutboat deploy, sproutboat tail, ...
```

`login` is one-time. It writes a long-lived token to
`~/.config/sproutboat/credentials.json`, keyed by API URL, so you can hold
logins for several instances at once. For CI or an agent, skip it and set
`SPROUTBOAT_API_URL` + `SPROUTBOAT_TOKEN`.

## Commands

The everyday loop:

| Command | What it does |
| --- | --- |
| `init [name]` | Scaffold `sproutboat.jsonc` + `src/index.js` |
| `dev [--port <n>]` | Run it here against a real broker, rebuilding on save |
| `deploy` | Build, provision bindings, upload, wait until the URL serves |
| `tail [--sprout]` | Recent request logs, or the running sprout's output |
| `rollback <id>` | Re-activate a previous version |

Then `check`, `build`, `versions`, `delete`, `login` / `logout` / `whoami`, and
one command per storage product — `kv`, `d1`, `r2`, `queues`, `secrets`,
`domains` — each with the same five verbs.

Run `sproutboat` with no arguments for the grouped list.
[`SURFACE.md`](SURFACE.md) is the generated inventory: every command, every
argument, every env var, kept honest by a drift test.

## Config

`sproutboat.jsonc`: the entry point plus Cloudflare-shaped `env.*` bindings.

```jsonc
{
  "name": "app",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26",

  "vars": { "SITE": "hi" },
  "secrets": ["API_KEY"],
  "kv_namespaces": ["CACHE"],                 // bare name, or { "binding": "CACHE", "id": "kv_..." }
  "d1_databases": ["DB"],
  "r2_buckets": ["UPLOADS"],
  "queues": ["JOBS"],
  "analytics_engine_datasets": ["METRICS"],   // bare name only, no id
  "durable_objects": { "COUNTER": "Counter" },
  "outbound": ["api.example.com"],
  "triggers": { "crons": ["*/5 * * * *"] },
  "assets": { "directory": "public", "binding": "ASSETS", "run_sprout_first": ["/api/*"] }
}
```

A bare `"CACHE"` binding is auto-provisioned on `deploy`: the CLI creates an
account-level resource and writes its id back into `sproutboat.jsonc`, so the
store survives redeploys. `--no-provision` keeps it a throwaway per-deploy
store instead.

The handler is `export default { fetch(request) }`. It may import from other
files in the project and from its own `node_modules`, and may also export
`scheduled(event)` / `queue(batch)` handlers and Durable Object classes. `env`
is a global, not a parameter, and every binding call is synchronous.
[`examples/kitchen-sink/`](examples/kitchen-sink) uses every binding.

`sproutboat dev` runs against a real local broker, so bindings behave like
production without a deploy — except `secrets`, which live only in the control
plane. Put values in a `.dev.vars` file next to `sproutboat.jsonc`
(`API_KEY=whatever`, one per line, gitignored) and `env.API_KEY` resolves under
`dev` only.

## Requirements

[Bun](https://bun.sh) 1.4+. The CLI fetches Zig automatically on first use and
ships a prebuilt uWebSockets, so it compiles nothing else from source. On
Windows, build from WSL.

## Limits

Capability profile `http-sync-v0`: one synchronous `fetch` handler, optional
`scheduled` / `queue` handlers, no streaming, no WebSockets. Binding values are
text/JSON, one at a time over a 32 MiB loopback frame. Sprout uploads cap at
16 MiB, assets at 64 MiB / 4096 files.

Porffor is pre-1.0, so some JavaScript does not survive the compile — CommonJS
`require`, dynamic `import()`, anything reaching `process`/`Bun`/`Deno`/`node:*`,
and `new Proxy(...)` (it compiles, then silently ignores every trap).
`sproutboat check` catches most of it before a build. The full list, and the
current sharp edges, are at [sproutboat.com/docs](https://sproutboat.com/docs).

## Bugs

File issues at
[baronunread/sproutboat/issues](https://github.com/baronunread/sproutboat/issues).

## Contributing

PRs welcome. [`MIGRATION.md`](MIGRATION.md) maps this repo back to the
monorepo it was extracted from.
