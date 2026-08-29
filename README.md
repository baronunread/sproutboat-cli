# sproutboat-cli

The Wrangler-shaped CLI for [Sproutboat](https://github.com/baronunread/sproutboat).
**MIT licensed** (the platform itself is not).

It speaks only the documented `/api` HTTP contract, so the same binary targets a
**self-hosted** instance or the **cloud** — you point it at a control-plane URL:

```sh
sproutboat login --api-url https://control.example.com --token <token>
# or per-invocation, for CI:
export SPROUTBOAT_API_URL=https://control.example.com SPROUTBOAT_TOKEN=<token>

sproutboat init hello
sproutboat deploy
sproutboat tail hello
sproutboat versions list hello
sproutboat rollback <id>
```

Credentials are keyed by API URL in `~/.config/sproutboat/credentials.json`, so
you can hold logins for several instances at once.

## Status

**Not yet migrated.** The working source currently lives in the monorepo at
[`sproutboat/apps/cli`](https://github.com/baronunread/sproutboat/tree/main/apps/cli).
See [MIGRATION.md](MIGRATION.md) for what needs to move here and what has to be
published as `@sproutboat/*` packages first.
