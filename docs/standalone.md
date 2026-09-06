# Standalone binaries

`sproutboat build --standalone` emits **one executable** that carries its own
bindings. No control plane, no edge, no Bun on the target: copy the file to a
machine and run it.

```sh
sproutboat build --standalone            # ~2 MB, SQLite compiled in
./dist/hello                             # serves on $PORT (default 8080)
```

The same handler source deploys to a box unchanged. That is the point: write a
mini app, run it on a Pi, later `sproutboat deploy` it.

## Two backends

| | `--standalone` (default) | `--standalone --backend bundled` |
| --- | --- | --- |
| Size | ~2 MB | ~60 MB |
| How | SQLite compiled into the sprout | the Bun broker stapled beside it |
| `fetch()` | `http://` only | `http://` and `https://` |

The embedded backend is the product. The bundled one survives because its
broker is Bun, which speaks TLS today. Reach for it when a handler must call an
https endpoint.

## Runtime surface

Everything a project declares — KV and D1 names, buckets, queues, DO classes,
cron expressions, the outbound allowlist, `vars` — compiles in. Three things do
not:

- `PORT`: the port to listen on.
- `--data <dir>` / `SPROUTBOAT_DATA`: where state lives.
- **Secrets**: from the environment, or `<data>/secrets.json`.

The binary never carries a secret, for the same reason an artifact never does:
the bytes are identical for everyone who has the file, and rotating a compiled
secret would mean rebuilding. The binary checks every declared secret at
startup, so a missing one refuses the boot and lists the names instead of
crashing on the first request that needs it.

## Where data lives

```
<name>.data/
  store.sqlite          kv · r2 · mq · do_storage · do_alarm · ae
  d1/<binding>.sqlite   one file per D1 database
```

D1 stays separate on purpose: it runs user-supplied SQL, so a handler's
`CREATE TABLE kv (...)` would otherwise collide with the platform's own tables.
WAL mode adds `-wal` and `-shm` beside `store.sqlite`.

The layout is identical to what `sproutboat dev` writes, which is what lets one
conformance suite run against both backends and mean something.

## What differs from a deployed sprout

- **Outbound `fetch()` speaks `http://` only** on the embedded backend. TLS
  needs a certificate store plus a crypto stack; an https call says so instead
  of failing obscurely.
- **Service bindings do not exist.** They call another deployment through an
  edge, which a standalone binary lacks.
- **Triggers stay internal.** Cron ticks, queue batches and DO alarms run on
  timers inside the process. A standalone binary refuses an external
  `x-sb-trigger` request outright: no broker means no token, and accepting
  unauthenticated triggers from the network would let anyone invoke
  `scheduled()`.
- **Assets compile in**, capped at 8 MB. Past that, serve them from R2 or put a
  web server in front.

## Checking a build

`bun run kitchen-sink:standalone` builds the example as one binary and runs the
same checks `bun run kitchen-sink` runs against the broker. If the two ever
disagree, one of the two implementations of the binding ops has drifted, which
is the whole risk of having a second one.
