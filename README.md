<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo-light.svg" alt="sproutboat" width="220" height="32">
</picture>

https://sproutboat.com

The CLI for [Sproutboat](https://github.com/baronunread/sproutboat). Compiles a
`fetch` handler to a native binary and ships it to any Sproutboat control plane.

## Issues

Tracked centrally in [baronunread/sproutboat](https://github.com/baronunread/sproutboat/issues)
(label `area:cli`). Please file there.

## Overview

Wrangler-shaped, MIT licensed. `build` and `deploy` cross-compile your handler
to a static `linux-x86_64` binary with [Porffor](https://porffor.dev) and Zig —
no Docker, no root, nothing to run as a daemon.

Full reference: [sproutboat.com/docs](https://sproutboat.com/docs) (plain text
for agents: [sproutboat.com/llms.txt](https://sproutboat.com/llms.txt)).

## Using

The npm package installs a small Node launcher and the matching native
platform package, so `npm install -g sproutboat` and `npm exec sproutboat` work
without Bun on `darwin` and `linux` for `arm64` and `x64`. The self-hosted
runtime exports remain in the root package for Bun-based platform integrations.
Nothing is needed on the machine that *runs* a sprout: that gets a static
binary.

The first build downloads the pinned Porffor source into
`~/.cache/sproutboat`, verifies its SHA-256, applies Sproutboat's compiler
patches there, and publishes the cache entry atomically. Installation itself
does not clone Porffor or invoke Git, Make, or a compiler. Warm-cache builds can
run offline.

```sh
npm exec sproutboat init hello
cd hello
npm exec sproutboat dev    # runs it right here, no control plane needed
```

Happy with it? Ship it:

```sh
bunx sproutboat login --api-url https://control.example.com   # one browser approval
bunx sproutboat deploy
```

Or install it once and drop the `npm exec`:

```sh
npm install -g sproutboat # then: sproutboat deploy, sproutboat tail, ...
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
| `tail [filters]` | Live request events, console output and exceptions, like `wrangler tail` |
| `rollback <id>` | Re-activate a previous version |

Then `check`, `build`, `versions`, `delete`, `login` / `logout` / `whoami`, and
one command per storage product — `kv`, `d1`, `r2`, `queues`, `secrets`,
`domains` — each with the same five verbs.

Run `sproutboat` with no arguments for the grouped list.

### Live tail

`sproutboat tail` streams one app's events as they happen. Each request prints
its time, method, URL, status, outcome and CPU and wall milliseconds; the app's
`console.*` output and uncaught exceptions print as their own lines.

```sh
sproutboat tail                                  # pretty, colored
sproutboat tail --status 5xx --search checkout   # server-side filters
sproutboat tail --format json | jq 'select(.outcome != "ok")'
sproutboat tail --recent                         # the last 100 request records (the old behaviour)
sproutboat tail --sprout                         # the sprout's raw stdout/stderr
```

| Flag | Meaning |
| --- | --- |
| `--format pretty\|json` | Colored lines (default), or one JSON event per line |
| `--status` | `ok` (below 400), `error` (5xx or a platform failure), a code like `404`, or a class like `5xx`; repeat or comma-separate |
| `--method` | `GET,POST`; repeat or comma-separate. Console-only events have no method, so this hides them |
| `--sampling-rate` | Keep this fraction of events, 0 to 1 |
| `--search` | Case-insensitive substring over the URL, console messages and exception text |
| `--outcome` | `ok`, `exception`, `exceededWallTime`, `canceled`, `unavailable`, `noRoute`, `proxyError`, ... |

Things to know:

- **Console lines are not tied to a request.** Concurrent requests share one
  process and the runtime does not tag a line with a request id, so console
  output is printed on its own, flush left, and never indented under a request.
  Lines carry the time the control plane saw them (about one second of
  resolution). The runtime sends `console.log`, `warn` and `error` to the same
  stream without a level, so they all show as `log`; uncaught exceptions are
  recognised and shown as errors with their stack.
- The server caps the stream at ten minutes and the CLI reconnects; events in
  the gap are not replayed. It also caps events per second and reports the
  count it dropped on stderr, which keeps stdout clean for `--format json`.
- Needs a control plane with `GET /api/projects/<name>/tail` (Sproutboat
  platform after v0.12.0). Against an older one, use `--recent`.
- Ctrl-C stops the stream and exits 0.
[`SURFACE.md`](SURFACE.md) is the generated inventory: every command, every
argument, every env var, kept honest by a drift test.

### Toolchain diagnostics

`sproutboat toolchain doctor` reports the selected Porffor, Zig, SQLite, and
BearSSL inputs, cache locations, active overrides, and host compiler
prerequisites. It never downloads a toolchain or starts a compiler. Use
`sproutboat toolchain doctor --json` for CI or support tooling.

### KV data and waitlist export

Manage one namespace by its account-level name:

```sh
sproutboat kv key list registrations --prefix email:
sproutboat kv key get registrations email:person@example.com --text
sproutboat kv key put registrations email:person@example.com joined
sproutboat kv key delete registrations email:person@example.com --yes
sproutboat kv export registrations --prefix email: --output registrations.json
```

Bulk put, and therefore exported dumps, use the version 1 text-value format:

```json
[
  { "key": "email:person@example.com", "value": "joined" }
]
```

`kv bulk get` and `kv bulk delete` accept a JSON array of key strings. `kv bulk
put` accepts the entry array above. The CLI sends large inputs in bounded
batches. Export pages through the namespace and writes incrementally to a
permission-restricted temporary file, then renames it into place only after a
complete export. Existing output files require `--force`.

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
  "queues": ["JOBS"],                         // or { "binding": "JOBS", "queue": "jobs", "max_retries": 3, "dead_letter_queue": "failed" }
  "analytics_engine_datasets": ["METRICS"],   // bare name only, no id
  "durable_objects": { "COUNTER": "Counter" },
  "ratelimiters": [{ "binding": "API", "limit": 100, "period": 60 }], // env.API.limit({ key })
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
is a global, not a parameter. Binding calls are synchronous until the compatibility
date that makes each one return a Promise, as on Workers (D1 from 2026-10-24, KV from
2026-10-25, R2 from 2026-10-26); `await` works at every date, so always await them.
[`examples/kitchen-sink/`](examples/kitchen-sink) uses every binding.

For objects larger than one request, use resumable R2 multipart uploads. The
[large-object guide](docs/r2-large-objects.md) covers part sizing, browser
chunking, resume state, cleanup, and the remaining download limitation.

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
`scheduled` / `queue` handlers. WebSockets (from compatibility date 2026-10-30; standalone
and platform sprouts from 2026-11-01) and outbound `new WebSocket(url)` (2026-11-01) are
supported. Binding values are
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
