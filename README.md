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
platform package, so `npm i -D sproutboat`, `npm i -g sproutboat` and `npx sproutboat` work
without Bun on `darwin` and `linux` for `arm64` and `x64`. The self-hosted
runtime exports remain in the root package for Bun-based platform integrations.
Nothing is needed on the machine that *runs* a sprout: that gets a static
binary.

The first build downloads the pinned Porffor source into
`~/.cache/sproutboat`, verifies its SHA-256, applies Sproutboat's compiler
patches there, and publishes the cache entry atomically. Installation itself
does not clone Porffor or invoke Git, Make, or a compiler. Warm-cache builds can
run offline.

Install it in each project, as you would Wrangler. The CLI is the compiler, so
a project that pins its version builds the same way on every machine and in CI:

```sh
npm i -D sproutboat       # pnpm add -D sproutboat, bun add -d sproutboat, yarn add -D sproutboat
```

`sproutboat init` does this for you: it writes a `package.json` with
`sproutboat` in `devDependencies` and `dev`, `deploy` and `check` scripts.

```sh
npx sproutboat init hello  # or: pnpm dlx sproutboat init hello, bunx sproutboat init hello
cd hello
npm install
npm run dev                # runs it right here, no control plane needed
```

Happy with it? Log in once, then ship it:

```sh
npx sproutboat login       # one approval in the browser; add --api-url for a self-hosted box
npm run deploy             # or: npx sproutboat deploy
```

For quick commands outside a project, install it globally. A global install is
not pinned to anything, so keep it for `init`, `login` and `whoami`:

```sh
npm i -g sproutboat       # then: sproutboat init, sproutboat whoami, ...
```

`login` is one-time. It writes the credential to `credentials.json` in the user
config directory (mode 0600), keyed by API URL, so you can hold logins for
several instances at once. The directory follows Wrangler: `SPROUTBOAT_CONFIG_DIR`
or `XDG_CONFIG_HOME` if set, else `~/Library/Preferences/sproutboat` on macOS and
`~/.config/sproutboat` elsewhere (the old macOS place is still read).

### Sproutboat Cloud

The default endpoint is `https://dash.sproutboat.com`, the Sproutboat Cloud.
`login` there is the device-code flow, like `gh auth login`:

```sh
sproutboat login           # prints a code and a link, opens the browser when it can
sproutboat whoami          # the team, the key and what it may do
sproutboat deploy          # uploads the app, waits for a host, prints the live URL
sproutboat logout          # deletes the key on the server, then the local copy
```

Open the link on any device where you are signed in, pick the team, check the
machine name and Approve. That mints an account API key named
`CLI on <hostname>` for that team, with your role capped at Developer. It shows
up under Settings, API keys, where you can revoke it. `--account <team>`
preselects the team on the approval page.

- **Which target.** Like Wrangler, there is one target, chosen by your
  credentials: the endpoint you are logged in to (`--api-url`, then
  `SPROUTBOAT_API_URL`, then the saved active endpoint, then the default).
  The CLI asks the endpoint what it is (`GET /v1/config`) and deploys the Cloud
  way to a Cloud and the Community way to a self-hosted box. There is no
  `--cloud` flag.
- **CI.** `SPROUTBOAT_API_TOKEN` (an account API key, like `CLOUDFLARE_API_TOKEN`)
  always wins over a stored login. `SPROUTBOAT_TOKEN` is the older name. With no
  terminal and no token, `deploy` fails and names `SPROUTBOAT_API_TOKEN`; in a
  terminal it starts the login itself.
- **Which team.** `account` in `sproutboat.jsonc` (like `account_id`), else
  `--account`, else `SPROUTBOAT_ACCOUNT`, else your only stored team, else a
  prompt. Precedence is `--account`, the config field, then the environment
  variable. A key from the environment belongs to one team, so a different
  `account` is an error.
- **Build.** The Cloud builds your app. `deploy` bundles the project here, uploads
  that one file by its sha256 (it skips the upload when the Cloud already has
  it), asks the Cloud to build it and streams the build log:

  ```
    Bundling   src/index.js (212 KiB)
    Uploading  source a3f1c9d2e044 (212 KiB)
    Building   queued (position 1)
    | porffor: compiled in 1.0 s
  ✓ Built in 4.1 s · peak memory 742 MB (cap 1200 MB)
  ```

  An identical build is answered from the Cloud's cache. Ctrl-C cancels the
  build. `--no-wait` returns once the build is accepted and prints
  `/v1/builds/<id>`. A queued build shows why it is held back (such as waiting for memory) and keeps
  waiting. A build that fails prints the reason and its peak memory, and exits 1; a source
  is limited to 8 MiB. `--module app.so` and `--sproutd` with `--generation`
  are operator paths for a prebuilt or locally compiled module; a team key is
  refused with "modules are built by the Cloud", and regular deploys never need
  them.
- **Result.** The first deploy creates the app (`Created`), later ones say
  `Updated`. The app is served at `https://<app>.<team>.sproutboat.app`, and the
  deploy waits until a host has applied the generation it printed.
  `--dry-run` prints the plan and says it would build in the Cloud, without
  uploading; `--no-wait` skips the wait.
- **Secrets.** As with Wrangler, secrets belong to the app and a deploy never
  wipes them. `sproutboat secrets put NAME` (value on stdin, or `--value`),
  `secrets list` and `secrets delete NAME` act on the deployed app at once; they
  need the `secret:write` and `secret:list` permissions and say so on a 403. An app
  that is not deployed yet has nowhere to keep them: deploy first, or pass
  `deploy --secrets-file <file>` (`.dev.vars` or `.env` syntax, `UPPER_SNAKE` names)
  on the first deploy; its values are merged into the app's secrets in the same
  write and nothing else is removed. A deploy never reads `.dev.vars` on its
  own (the Community deploy does not either): name the file. Production
  values do not belong in `.dev.vars`; keep a separate file.
- **Service bindings.** `services: [{ "binding": "PEER", "service": "quote-service" }]`
  binds to the Cloud app of that name in the same team. `deploy` looks the app
  up first and refuses, before uploading anything, when it is not deployed
  (deploy it first, with `sproutboat deploy` in its directory), when it is the
  app itself, or when `compatibility_date` is older than `2026-11-18`, the date
  from which the platform runtime serves service bindings between Cloud apps.
  Hosts need the matching sproutd support.
- **Not sent yet.** Other bindings (KV, D1, R2, queues, Durable Objects) and cron
  triggers in `sproutboat.jsonc` are not sent to the Cloud by the CLI yet; the
  deploy warns and the app runs without them. `secrets` names in
  `sproutboat.jsonc` only declare them. Static assets are uploaded by content hash.

For self-hosted (Community) endpoints, `login` keeps the browser flow, and for
CI or an agent you can skip it and set `SPROUTBOAT_API_URL` + `SPROUTBOAT_API_TOKEN`.

## Commands

The everyday loop:

| Command | What it does |
| --- | --- |
| `init [name]` | Scaffold `sproutboat.jsonc`, `src/index.js` and a `package.json` that pins `sproutboat` |
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
(`API_KEY=whatever`, one per line, gitignored), or use the `.env` files or
`sproutboat dev --env-file <file>`, as in Wrangler (`.dev.vars` or `.env`, never
both), and `env.API_KEY` resolves under `dev` only. A declared secret with no
value is a warning. The rules, the dotenv syntax, and `sproutboat run` for
launching a standalone binary (which fails on a missing declared secret) are in
[docs/standalone.md](docs/standalone.md#launching-with-sproutboat-run).

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
