# sproutboat

The CLI for [Sproutboat](https://github.com/baronunread/sproutboat). It is a
Wrangler-shaped tool that compiles a `fetch` handler to a native binary and
ships it to any Sproutboat control plane. MIT licensed.

Full reference: [sproutboat.com/docs](https://sproutboat.com/docs)
(plain text for agents: [sproutboat.com/llms.txt](https://sproutboat.com/llms.txt)).

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

Want it shorter? Alias it yourself: `alias sprout='sproutboat'`.

The `login` browser step is one-time. It writes a long-lived token to
`~/.config/sproutboat/credentials.json`, keyed by API URL, so you can hold
logins for several instances at once. For CI or an agent, skip `login`
entirely and set `SPROUTBOAT_API_URL` + `SPROUTBOAT_TOKEN` (copy the token out
of that file).

## Commands

| Command | What it does |
| --- | --- |
| `init [name]` | Scaffold `sproutboat.jsonc` + `src/index.js` |
| `check` | Validate the config and entry point |
| `dev [--port <n>] [--no-watch]` | Run the project on this machine against a real broker, rebuilding on save |
| `build [--target host]` | Cross-compile the sprout binary (Porffor + Zig); `--target host` builds for this machine instead, for `dev` — not deployable |
| `deploy [--dry-run] [--no-wait] [--no-provision] [--artifact <dir>]` | Build, auto-provision id-less storage bindings, upload, wait until the URL serves |
| `login [--api-url <url>] [--token <token>]` | Browser device flow, or store a token directly |
| `tail [name] [--sprout]` | Recent request logs; `--sprout` streams the running sprout + broker output |
| `versions <list \| view <id>>` | Deployed versions, or one version's artifact and bindings |
| `rollback <id>` | Activate a previous version |
| `logout [--api-url <url>]` | Forget the stored credential |
| `whoami` | Active endpoint and the account the token belongs to |
| `kv <list \| create \| info \| rename \| delete>` | KV namespaces |
| `d1 <list \| create \| info \| rename \| delete>` | D1 databases |
| `r2 <list \| create \| info \| rename \| delete>` | R2 buckets |
| `queues <list \| create \| info \| rename \| delete>` | Queues |
| `secrets <list \| put <NAME> [--value <v>] \| delete <NAME>>` | Encrypted project secrets, read as `env.NAME` |
| `domains <list \| add <host> \| verify <host> \| delete <host>>` | Attach your own hostname (TXT + A, apex allowed) |
| `delete --yes` | Delete the project, every version, and its route |

Each storage product is its own command with the same five verbs. Wrangler nests
two of its four (`kv namespace create`, `r2 bucket create`) and leaves the other
two flat; the nesting separates a container from its contents, which the verb
already does, so ours are uniform. Contents get their own noun when they arrive
(`kv key get`, `r2 object put`).

Run `sproutboat` with no arguments for the grouped list.
[`SURFACE.md`](SURFACE.md) is the generated inventory of every command and env var.

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
account-level resource, writes its id back into `sproutboat.jsonc`, and the
store then survives redeploys. Pass `--no-provision` to keep it a throwaway
per-deploy store instead, or `sproutboat kv create <name>` (or `d1`/`r2`/`queues`) to make one up front
and share its id across projects.

The handler is `export default { fetch(request) }`; it may import from other
files in the project and from its own `node_modules`, and optionally export
`scheduled(event)` / `queue(batch)` handlers and Durable Object classes.
`env` is a global (not a parameter), and every binding call is synchronous.
See [`examples/kitchen-sink/`](examples/kitchen-sink) for one app that uses
every binding.

`sproutboat dev` runs against a real local broker, so bindings behave like
production without a deploy — except `secrets`, which live only in the
control plane. Give it a value with a `.dev.vars` file next to
`sproutboat.jsonc` (`API_KEY=whatever`, one per line, gitignore it):
`env.API_KEY` then resolves to that value under `dev` only.

## Requirements

- [Bun](https://bun.sh) 1.4+

`build` / `deploy` cross-compile the handler to a static `linux-x86_64` binary
with Porffor and Zig (the CLI fetches Zig automatically on first use). The
package ships a prebuilt uWebSockets and compiles nothing else from source. No
Docker, no root. On Windows, build from WSL.

If that prebuilt is unusable (a `porffor` pin bump before the archive is
refreshed), the first build falls back to compiling uWebSockets locally, which
needs `git` and `make` on `PATH`. `SPROUTBOAT_UWS_TARBALL=<archive>` overrides
the shipped one.

## Limits

Capability profile `http-sync-v0`: one synchronous `fetch` handler, optional
`scheduled` / `queue` handlers, no streaming, no WebSockets. Binding values are
text/JSON and travel one at a time over the loopback frame (32 MiB cap);
large-object R2 is [#56](https://github.com/baronunread/sproutboat/issues/56).
The sprout upload caps at 16 MiB, assets at 64 MiB / 4096 files. The entry
point is bundled before it compiles, so relative imports and npm dependencies
from the project's own `node_modules` work; CommonJS `require`, dynamic
`import()`, and any `process`/`Bun`/`Deno`/`node:*` reached even through a
dependency do not. `new Proxy(...)` compiles but its traps are silently
ignored by Porffor alpha, so it's rejected too. A parsed `Date` with a numeric
timezone offset (`+02:00`) currently comes out wrong; plain ISO-8601 UTC
strings are fine. `sproutboat check` catches most of this before a build.
Full list at [sproutboat.com/docs](https://sproutboat.com/docs).

---

Contributors: [`MIGRATION.md`](MIGRATION.md) maps this repo back to the monorepo.
[`SURFACE.md`](SURFACE.md) is a generated inventory of every command and env var.
