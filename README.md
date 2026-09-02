# sproutboat

The CLI for [Sproutboat](https://github.com/baronunread/sproutboat). It is a
Wrangler-shaped tool that compiles a `fetch` handler to a native binary and
ships it to any Sproutboat control plane. MIT licensed.

Full reference: [sproutboat.com/docs](https://sproutboat.com/docs)
(plain text for agents: [sproutboat.com/llms.txt](https://sproutboat.com/llms.txt)).

```sh
bunx sproutboat login --api-url https://control.example.com   # one browser approval
bunx sproutboat init hello
cd hello
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
| `build` | Cross-compile the sprout binary (Porffor + Zig) |
| `deploy [--dry-run] [--no-wait] [--no-provision] [--artifact <dir>]` | Build, auto-provision id-less storage bindings, upload, wait until the URL serves |
| `login [--api-url <url>] [--token <token>]` | Browser device flow, or store a token directly |
| `tail [name] [--sprout]` | Recent request logs; `--sprout` streams the running sprout + broker output |
| `versions list [name]` | Deployed versions |
| `rollback <id>` | Activate a previous version |
| `secrets [list \| set <NAME> [value] \| rm <NAME>]` | Encrypted project secrets, read as `env.NAME` |
| `resource [list \| create <kind> <name> \| rename <id> <name> \| delete <id>]` | Account-level KV / D1 / R2 / queue stores |
| `domains [list \| add <host> \| verify <host> \| rm <host>]` | Attach your own hostname (TXT + A, apex allowed) |
| `delete --yes` | Delete the project, every version, and its route |

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
per-deploy store instead, or `sproutboat resource create` to make one up front
and share its id across projects.

The handler is one `export default { fetch(request) }`, optionally with
`scheduled(event)` / `queue(batch)` handlers and Durable Object classes above
it. `env` is a global (not a parameter), and every binding call is synchronous.
See [`examples/kitchen-sink/`](examples/kitchen-sink) for one app that uses
every binding.

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
The sprout upload caps at 16 MiB, assets at 64 MiB / 4096 files. Node
compatibility is Porffor alpha, so `import`/`require`, `process`, `node:*`, and
parsing date strings do not work; `sproutboat check` catches most of it. Full
list at [sproutboat.com/docs](https://sproutboat.com/docs).

---

Contributors: [`MIGRATION.md`](MIGRATION.md) maps this repo back to the monorepo.
[`SURFACE.md`](SURFACE.md) is a generated inventory of every command and env var.
