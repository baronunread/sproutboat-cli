# Standalone binaries

`sproutboat build --standalone` emits **one executable** that carries its own
bindings. No control plane, no edge, no Bun on the target: copy the file to a
machine and run it.

```sh
sproutboat build --standalone            # ~2 MB: SQLite and TLS compiled in
PORT=3000 ./dist/hello                   # serves on $PORT (default 8080)
```

The same handler source deploys to a box unchanged. That is the point: write a
mini app, run it on a Pi, later `sproutboat deploy` it.

## Runtime surface

Everything a project declares — KV and D1 names, buckets, queues, DO classes,
cron expressions, the outbound allowlist, `vars` — compiles in. Three things do
not:

- `PORT`: the port to listen on.
- `SB_DATA_DIR` or `SPROUTBOAT_DATA`: where state lives.
- `SB_TRUSTED_PROXIES`: trusted reverse-proxy CIDRs, for the client IP (below).
- **Secrets**: from the environment, or `<data>/secrets.json`.

All three arrive through the environment, and none of them through flags: a
native-fetch binary never sees `argv`, because Porffor's runtime init calls
`porf_init(0, NULL)`. That suits systemd and docker, which set environment
variables anyway.

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
  backups/<file>        snapshots written by env.<D1>.backup()
```

D1 stays separate on purpose: it runs user-supplied SQL, so a handler's
`CREATE TABLE kv (...)` would otherwise collide with the platform's own tables.
WAL mode adds `-wal` and `-shm` beside `store.sqlite`.

### Backing up D1

`env.<D1>.backup(name?)` — a Sproutboat extension, not in Workers — writes a
consistent single-file snapshot of that database to `backups/`, with no
downtime (SQLite holds a read transaction for the copy) and no WAL sidecars.
It reopens the copy and runs `PRAGMA integrity_check` before returning
`{ path, bytes }`, so a bad backup fails at the call, not on restore. `name`
must be a plain filename; anything else gets a timestamped default. Wire it to
an admin route and copy `backups/` off the box; restore by putting the file
back at `d1/<binding>.sqlite` on a stopped binary.

The layout is identical to what `sproutboat dev` writes, which is what lets one
conformance suite run against both the broker and this binary and mean
something.

## Client IP

`request.cf.clientIp` is the connection's remote address. A client-sent
`x-sb-remote-addr` header is dropped before the handler runs — the server owns
that name — so with the binary exposed directly the value cannot be forged.

Behind a reverse proxy the connection comes from the proxy, so set
`SB_TRUSTED_PROXIES` to a comma-separated list of the proxy's addresses, as
CIDRs or bare IPs (`SB_TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8`). When the peer is
one of those, `clientIp` becomes the right-most `X-Forwarded-For` entry that is
not itself a trusted address; with the list unset or the peer not in it,
`X-Forwarded-For` is ignored entirely. Your proxy must *overwrite*
`X-Forwarded-For`, not append — appenders let a visitor prepend a fake hop.

IPv4-mapped IPv6 peers (`::ffff:1.2.3.4`) are folded to the dotted form. CIDR
ranges are IPv4; an IPv6 proxy must be listed as a bare address.

## What differs from a deployed sprout

- **Outbound `fetch()` speaks `http://` only.** TLS needs a certificate store
  plus a crypto stack; an https call says so instead of failing obscurely. See
  "Talking to https services" below — a local proxy covers this, which is why
  a TLS stack in the binary is not on the roadmap.
- **Service bindings do not exist.** They call another deployment through an
  edge, which a standalone binary lacks.
- **Triggers stay internal.** Cron ticks, queue batches and DO alarms run on
  timers inside the process. A standalone binary refuses an external
  `x-sb-trigger` request outright: no broker means no token, and accepting
  unauthenticated triggers from the network would let anyone invoke
  `scheduled()`.
- **Assets compile in**, capped at 8 MB. Past that, serve them from R2 or put a
  web server in front.

## TLS, in both directions

**Inbound is not this binary's job.** It serves plain HTTP on `$PORT`; put
Caddy, nginx or a tunnel in front and let that terminate. celld draws the same
line — it does not terminate TLS either.

```caddyfile
notes.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**Outbound happens in the binary.** `fetch("https://...")` verifies the
server against curl's Mozilla-derived root set, compiled in via BearSSL. That
follows workerd (BoringSSL under KJ) and celld (a bundled Mozilla root store):
a runtime that lets handlers call the internet needs its own TLS client, and a
proxy in front of the app does nothing for requests the app makes.

Routing egress through a local proxy would work, but it would change the URL a
handler writes — `http://127.0.0.1:9001/v1/charges` instead of
`https://api.stripe.com/v1/charges` — and "the same handler source deploys to
the edge unchanged" is the point of a standalone build.

Two behaviours worth knowing:

- `SB_CA_BUNDLE` points at a different PEM bundle, for a private or corporate
  CA. It adds trust; nothing disables verification.
- A server that closes without `close_notify` is normal on `Connection: close`,
  and BearSSL reports it as an I/O error. The binary accepts that case only when
  `Content-Length` says the body arrived whole; otherwise it fails the call
  instead of handing a handler a truncated response.

## Checking a build

`bun run kitchen-sink:standalone` builds the example as one binary and runs the
same checks `bun run kitchen-sink` runs against the broker. If the two ever
disagree, one of the two implementations of the binding ops has drifted, which
is the whole risk of having a second one.
