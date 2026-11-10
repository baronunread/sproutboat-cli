# Standalone binaries

`sproutboat build --standalone` emits **one executable** that carries its own
bindings. No control plane, no edge, no Bun on the target: copy the file to a
machine and run it.

```sh
sproutboat build --standalone            # ~6.5 MB, static: SQLite and the TLS client compiled in
sproutboat build --standalone --release  # the same with LTO: slower to build, faster to serve
PORT=3000 ./dist/hello                   # serves on $PORT (default 8080)
```

The same handler source deploys to a box unchanged. That is the point: write a
mini app, run it on a Pi, later `sproutboat deploy` it.

## Runtime surface

Everything a project declares — KV and D1 names, buckets, queues, DO classes,
cron expressions, `vars` — compiles in. Six things do
not:

- `PORT`: the port to listen on.
- `SB_DATA_DIR` or `SPROUTBOAT_DATA`: where state lives.
- `SB_TRUSTED_PROXIES`: trusted reverse-proxy CIDRs, for the client IP (below).
- `SB_EGRESS_ALLOW`: private addresses `fetch()` may reach, `*` or a
  comma-separated list of exact addresses. `fetch()` reaches any public address
  and refuses private and reserved ones (loopback, RFC 1918, link-local and
  cloud metadata, and the rest) unless they are listed here, for example a
  database on the same host.
- `SB_LOG=json`: structured request and error records on stderr (see
  [Logs](#logs)). Off by default.
- **Secrets**: from the environment, one variable per declared secret. Set them
  with `sproutboat run --env-file` (below), systemd's `EnvironmentFile=`, or
  your container's environment.

All six arrive through the environment, and none of them through flags: a
native-fetch binary never sees `argv`, because Porffor's runtime init calls
`porf_init(0, NULL)`. That suits systemd and docker, which set environment
variables anyway.

The binary never carries a secret, for the same reason an artifact never does:
the bytes are identical for everyone who has the file, and rotating a compiled
secret would mean rebuilding. A missing secret does not stop the binary from
starting; it throws the first time the handler reads it.

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

`sproutboat dev` talks to the same broker transport a deployed sprout does,
over a local SQLite state dir. Every binding op behaves the same in all three
places (dev, this binary, deployed). That includes rate limiters and
`request.cf.clientIp` with `SB_TRUSTED_PROXIES`, which the dev server passes
through from your own environment. The only differences are the ones under
"What differs from a deployed sprout" below, and each is a property of the
standalone binary, not of dev.

## Launching with `sproutboat run`

```sh
sproutboat run [project-dir] [--binary <file>] [--env-file <file>]... [--port <n>]
               [--data-dir <dir>] [--require <NAME,...>] [--check]
```

`run` starts the binary with the settings it takes at launch, none of them
baked in, so the identical file moves between machines:

```sh
sproutboat run --env-file dev.env --port 8080 --data-dir ./dev-data
sproutboat run --env-file /etc/notes/prod.env --port 80 --data-dir /var/lib/notes
```

The binary is `--binary`, or `dist/<name>` in the project (`build --standalone`'s
default). The declared secrets are the `secrets` in `sproutboat.jsonc` plus any
`--require` names; without a project, `--binary` and `--require` are enough.

**Precedence**, highest first, for every variable:

1. `--port` (sets `PORT`) and `--data-dir` (sets `SB_DATA_DIR`, resolved to an absolute path);
2. the `--env-file` files; repeat the flag and a later file overrides an earlier one;
3. the environment `run` was started from, which is how systemd or a container hands a
   production binary its settings.

So a stale `export API_KEY=...` in your shell loses to the file you named, and
`--port` wins over a `PORT` line in a file. `run` reads only the files you name:
it never picks up `.dev.vars` or `.env` on its own.

**A declared secret that is unset or empty fails the launch**, before the binary
starts and so before it accepts a request, naming the secrets and not their
values; this is the production counterpart of `wrangler deploy` failing on a
missing required secret. (`sproutboat dev` only warns, below.) `--check` runs all
the validation and prints the summary without starting the binary. Nothing is
written to disk, and the summary names each secret with the layer it came from
(`API_KEY (env file)`), never a value. Launch settings live in the env files and
the command line, separate from the build output and the artifact metadata.

`run` stays in the foreground, passes SIGINT, SIGTERM and SIGHUP to the binary,
and exits with its status (128 plus the signal number if a signal ended it).
Other variables in the files (`SB_TRUSTED_PROXIES`, `SB_EGRESS_ALLOW`, ...) are
passed to the binary too.

### Env file syntax

`dev` and `run` read the dotenv syntax:

```sh
# a comment line
API_KEY=abc123
export DB_URL = postgres://user:pass@host/db
GREETING='literal $text, \n and # kept'
MESSAGE="newline \n expands in double quotes"
NOTE=plain value   # a comment after an unquoted value
PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...
-----END PRIVATE KEY-----"
```

- `NAME=value`, optionally `export NAME=value` or `NAME: value`. Names are letters,
  digits, `_`, `.` and `-`.
- Single quotes and backticks are literal. Double quotes turn `\n` and `\r` into
  newlines. A quoted value may span lines. There is no `$VAR` interpolation.
- An unquoted value ends at a `#` (a comment) and is trimmed, so quote a value
  that contains one.
- The last of a repeated name wins.
- A line that is not an assignment, or a quote that never closes, is skipped with
  a warning such as `dev.env:7: skipped, not a NAME=value assignment`. Warnings
  never repeat the text of a line, so a value cannot leak through one.

### `sproutboat dev` follows Wrangler

`sproutboat dev` takes local secrets from files, by the same rules as `wrangler dev`:

- **`.dev.vars` or the `.env` files, never both.** If `.dev.vars` exists beside
  `sproutboat.jsonc`, the `.env` files are not loaded (a warning names them). With
  `--env <name>`, `.dev.vars.<name>` replaces `.dev.vars` when it exists.
- **The `.env` files layer, most specific first:** `.env.<name>.local`, `.env.local`,
  `.env.<name>`, `.env`. (Without `--env`, just `.env.local` and `.env`.)
  `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` turns this off.
- **`--env-file <file>`** replaces that default set. Repeat it and a later file
  overrides an earlier one. A named file that does not exist is an error. `--env`
  only selects local files here; named configuration environments are #267.
- **The process environment is not passed to the app.** Only with
  `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, and only when no `.dev.vars` is in use,
  does a declared secret take its value from the environment, and the files win
  over it.
- **A declared secret with no value is a warning and `dev` still starts.** A handler
  that reads it throws, as in production.
- `secrets` is a plain list of names here, so every name in the files is passed
  through, as `.dev.vars` always did.

### On a server without the CLI

systemd does the same job: `EnvironmentFile=/etc/notes/prod.env` (its syntax is
simpler than dotenv: no multi-line values, so keep a production file to plain
`NAME=value` lines). `examples/vars-secrets` walks the same binary through
development and production.

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

## Logs

By default a binary writes nothing per request; an uncaught handler error goes
to stderr as `Uncaught (in fetch) ...` text, and your own `console.log` goes to
stdout. Start it with `SB_LOG=json` and stderr carries one JSON line per
request and one per uncaught error instead, which `sproutboat tail --file`
follows and filters.

```sh
SB_LOG=json ./notes 2>> /var/log/notes.jsonl
sproutboat tail --file /var/log/notes.jsonl --status 5xx
```

Under systemd, `Environment=SB_LOG=json` and `StandardError=append:/var/log/notes.jsonl`
do the same, or pipe the journal: `journalctl -u notes -f -o cat | sproutboat tail --file -`.

A request record is written once the response is built:

```json
{"type":"request","v":1,"id":"1762600000-17","timestamp":1762600012345,"method":"GET","path":"/notes","status":200,"durationMs":3,"outcome":"ok"}
```

`outcome` is `exception` when the handler threw (the status is then 500). An
error record is written for every uncaught error: a `fetch` handler, `scheduled`,
`queue`, an alarm, a WebSocket handler, a rejected promise (`promise`) or a
`ctx.waitUntil` task (`waitUntil`):

```json
{"type":"error","v":1,"id":"1762600000-18","timestamp":1762600012399,"source":"fetch","name":"TypeError","message":"Cannot read properties of undefined","stack":"..."}
```

An error raised while answering a request has that request's `id`, so
`jq 'select(.id=="1762600000-18")'` pulls up both lines. Errors from work that
belongs to no request (a cron, a queue batch, an alarm, an unawaited promise)
have `"id":null`. `timestamp` is milliseconds since the epoch.

What is left out: request and response bodies, headers (cookies and
`Authorization` included), the query string (tokens end up there), and the
client address. The value of a declared secret is replaced with `[redacted]`
wherever it appears in an error's message or stack; other text your code puts in
an error message is written as it is, so do not put credentials in one.

Output is bounded. Paths are cut at 256 characters, messages at 1000 and stacks
at 2000, and at most 200 lines a second are written. Past that the records are
counted, not written, and the next second starts with
`{"type":"dropped","v":1,"timestamp":...,"count":40,"reason":"rate"}`. Rotating
the log is your job (`logrotate` with `copytruncate`, or journald); the binary
only writes to stderr.

Other lines in the same file (a startup banner, plain text from the runtime) are
skipped by `tail --file`. Records of a different `v` are skipped too.

### `sproutboat tail --file`

```sh
sproutboat tail --file <log|-> [--lines <n>] [--no-follow] [--format pretty|json]
                [--status ok|error|<code>|5xx] [--method GET,POST] [--search <text>]
```

It prints the last 10 matching records (`--lines`, 0 for none), then keeps
following and prints new ones as they are written. `--no-follow` prints that
snapshot and exits. `--file -` reads standard input until it ends. It needs no
login and no network. Ctrl-C and SIGTERM end it with exit 0.

- `--format json` writes one record per line to stdout and nothing else; notices
  (waiting, rotation, skipped lines) go to stderr, so the output stays parseable.
  Only the fields above are written, whatever the log contains.
- `--status`, `--method` and `--search` mean what they do for a deployed app
  (`ok` is a success below 400, `error` a 5xx or a thrown handler). They select
  requests; an error is shown when its request is, and an error with no request is
  always shown. `--sampling-rate` and `--outcome` are not available for a file.
- Reconnecting: a missing file is waited for. A file replaced by rotation
  (renamed away, new file in its place) is reopened and read from its start, and
  a file truncated in place is read again from its start, noticed when it is
  shorter than what was already read. A line over 64 KiB is skipped and counted
  rather than held in memory.
- For a deployed app, `sproutboat tail` without `--file` streams the same kind of
  events from the control plane (see `sproutboat tail --help`).

## Known issue: an async handler can livelock at 100% CPU

Any `fetch` handler whose result resolves a promise with a plain object —
returning a `Response` from an `async` function is the common shape, so this
is not a rare pattern — can wedge the process at 100% CPU after a handful of
requests, with no error and no log line (upstream Porffor, alpha-5; tracked
as [#168](https://github.com/baronunread/sproutboat/issues/168)). Root cause:
a duck-typing check for `.then` walks the resolved value's prototype chain
and, under certain allocator conditions, never finds the terminator — an
infinite spin, not a slow leak. Onset is allocator-dependent, so it does not
reproduce reliably from run to run, and it is *not* specific to any one API —
an earlier version of this note said to avoid `Date.prototype.toISOString()`,
which only ever correlated with one specific repro, not the actual trigger.
Sync-only handlers are unaffected, since nothing ever resolves a promise.

Fixed by a local patch to Porffor's `.then` probe (see the
[platform upstream note](https://github.com/baronunread/sproutboat/blob/main/patches/upstream/promise-resolution-livelock.md)).
Current CLI releases include that toolchain patch. Builds using an older
toolchain remain affected; the exact allocator trigger isn't something a safe
subset of `async`/`await` usage can dodge. Track
[#168](https://github.com/baronunread/sproutboat/issues/168) for the release
that carries it.

## What differs from a deployed sprout

- **Service bindings do not exist.** They call another deployment through an
  edge, which a standalone binary lacks.
- **Triggers stay internal.** Cron ticks, queue batches and DO alarms run on
  timers inside the process. A standalone binary refuses an external
  `x-sb-trigger` request outright: no broker means no token, and accepting
  unauthenticated triggers from the network would let anyone invoke
  `scheduled()`.
- **Assets compile in**, capped at 8 MB. Past that, serve them from R2 or put a
  web server in front.

## Concurrency and scaling

One binary runs its handler on a single thread: the uWebSockets event loop
accepts connections and flushes responses concurrently, but the handler body
and every embedded binding call (D1, KV, R2, DO storage) execute serially, one
request at a time. A CPU-bound or IO-heavy handler therefore has a per-core
throughput ceiling of roughly `1 / handler-time`; adding client concurrency
past two or three in flight only grows latency (Little's law), it does not add
throughput. This is the runtime model, not a lock that can be narrowed:
Porffor's compiled runtime keeps one linear memory and is not built to run two
handler turns at once. It is also why a handler that calls its own service
binding would deadlock, and why standalone has none.

For most workloads this is not the wall it once was: a trivial write is tens of
microseconds and a handful of indexed reads is around a hundred, so a single
core clears well over ten thousand requests a second.

When one core is not enough, run several copies of the binary on the **same
`$PORT` and the same `SB_DATA_DIR`, with `SB_SQLITE_EXCLUSIVE=0`**. A standalone
binary opens its SQLite files in exclusive locking mode by default (one process
holds the lock for as long as it runs), so a second copy cannot open them; set
`SB_SQLITE_EXCLUSIVE=0` on every copy to go back to shared locking, which costs
some of the speed the exclusive lock buys. uWebSockets listens with `SO_REUSEPORT`,
so on Linux the kernel load-balances incoming connections across every copy,
and each copy is an independent runtime on its own core. The shared SQLite
files are safe across processes: WAL allows any number of readers plus one
writer, and `PRAGMA busy_timeout` (set to 5s by the runtime) makes a writer
wait for the lock rather than fail. A process manager owns the fan-out:

```ini
# systemd: four workers, restarted independently
[Service]
Environment=PORT=8080 SB_DATA_DIR=/var/lib/notes SB_SQLITE_EXCLUSIVE=0
ExecStart=/usr/local/bin/notes
[Install]
WantedBy=multi-user.target
```

installed as a template (`notes@.service`) and enabled `notes@{1,2,3,4}`, or
any equivalent. macOS `SO_REUSEPORT` does not load-balance, so a host build
scales only on the deploy target. "Restarting without dropping a request" below is for one binary on one
socket. Copies that each bind their own `SO_REUSEPORT` socket close it when they
are replaced, and the connections waiting on it are reset.

## Building for another machine

`sproutboat build --standalone` builds a static Linux binary from any machine,
macOS included, with no Docker and no Linux box:

```sh
sproutboat build --standalone                          # linux-x64, the default
sproutboat build --standalone --target linux-arm64     # a Raspberry Pi, Graviton, Ampere
sproutboat build --standalone --target host            # this machine, to run it here
```

`linux-x86_64` and `linux-amd64` mean `linux-x64`; `linux-aarch64` means
`linux-arm64`. Only `--standalone` takes `linux-arm64`: the platform that
`deploy` targets runs x86_64.

How it is built, so it is the same on every machine: the pinned Zig (see
`sproutboat toolchain doctor`) cross-compiles everything with `zig cc -target
<arch>-linux-musl` and links it statically against musl. musl, not glibc,
because a glibc binary is only static if you give up name resolution and
`dlopen`, and the binary then needs the build machine's glibc version on the
box. A musl binary needs nothing from the box: no libc, no certificates (the
Mozilla roots are compiled in), no `/etc/passwd`. That is also what lets the
container image below start `FROM scratch`. Porffor's generated C, uSockets
(built from the vendored source, patched for the restart hook), SQLite and
BearSSL are all compiled for the target architecture; the first build for a new
architecture compiles them (about a minute) and caches the objects under
`~/.cache/sproutboat`.

Check it: `file dist/app` says `ELF 64-bit LSB executable, ARM aarch64 ...,
statically linked`. The x86_64 binary built on macOS runs on a Linux x86_64 box
unchanged; build and test an arm64 one on arm64 Linux hardware (or in an arm64
container: `docker run --rm --platform linux/arm64 -v $PWD/dist:/t alpine /t/app`).

## Dev and release builds

`sproutboat build --standalone` links **without LTO** by default. Every unit still
compiles at `-O3`; only the final link skips link-time optimization. Pass
`--release` (or set `SPROUTBOAT_RELEASE=1`) for the full `-flto -O3` build, and use
it for any binary you publish or benchmark:

```sh
sproutboat build --standalone                 # no LTO: for local runs, CI, tests
sproutboat build --standalone --release       # -flto -O3: the binary you ship
```

The two are separate builds. The mode is part of the build-cache key and of every
compiled unit's stamp, so a release binary is never served from a non-release
cache entry or the other way round. Switching modes recompiles the units once.
`deploy` and `build` without `--standalone` are unaffected. `SPROUTBOAT_FLTO=1|0`
still overrides the link either way, for measurements.

What it costs and saves, on the macOS arm64 build machine (load average 3 to 5,
`/usr/bin/time -l`, whole build including the compiler's own processes):

| Build (`--target host`) | Cold build | Peak memory | Rebuild after an edit (units cached) | Binary |
| --- | --- | --- | --- | --- |
| hello, no LTO | 21.1 s | 845 MB | 3.2 s, 401 MB | 5.7 MB |
| hello, `--release` | 36.7 s | 1019 MB | 26.7 s, 1025 MB | 5.1 MB |
| kitchen-sink, no LTO | 23.8 s | 909 MB | 1.4 s, 468 MB | 6.1 MB |
| kitchen-sink, `--release` | 38.7 s | 1097 MB | 27.2 s, 1092 MB | 5.5 MB |

A cold build is 1.6 to 1.7x faster; an edit rebuild, which is a relink, is 8 to
20x faster and uses about 40% of the memory. The cold peak is set by compiling
the 14 MB prelude unit, which both modes do, so the saving there is smaller than
at the link itself. The binary is about 11% larger without LTO.

Serving speed (wrk, 4 threads, 64 connections, 10 s, three runs in each of two
rounds, median): hello `/` 55.6k against 59.8k requests per second (7% fewer),
kitchen-sink `/hash` (SHA-256, HMAC and scrypt) 247 against 269 (8% fewer). Both
are noisy on a busy machine, and a request-heavy app with SQLite and larger
handlers can lose more: an earlier profile on the same hardware saw 3% to 20%.
Treat a non-release binary as something to run and test, never to benchmark or
publish.

## Restarting without dropping a request

Replacing a running binary used to reset about one request in a few thousand.
The cause is in the kernel, not the server: closing a listening socket resets
every connection that has completed its handshake and is waiting to be
accepted, and a restart closes it (the old process exits, or closes its own
`SO_REUSEPORT` listener once the new one is up). Draining first does not help,
because one more connection can arrive between the last `accept()` and the
`close()`.

So the fix is never to let a restart be the last close of the socket. The
binary supports two ways to keep it open, and both use systemd's
`sd_listen_fds` convention (`LISTEN_PID`, `LISTEN_FDS`, the socket in fd 3), so
the binary has one way in:

- **systemd socket activation.** systemd owns the socket. The binary serves on
  it instead of binding `$PORT`. `systemctl restart` stops and starts the
  service while the socket stays open: connections wait in the queue (up to
  `Backlog=`) and the new binary accepts them. Nothing is reset. This is the
  one to use on a VPS.
- **`kill -USR2`**, for a box without systemd, or any supervisor that is not a
  socket holder. The running binary starts the file now on disk (its own path,
  or `SB_EXEC_PATH`) as a child that inherits the listening socket, then drains
  and exits. The same swap, done by the binary itself.

Both end the same way for the old process, which drains: it stops accepting,
adds `Connection: close` to every response (so a keep-alive client stops
reusing the connection, which is what would otherwise be reset in the one
instant the process exits), and exits once nothing is in flight. `SIGTERM` and
`SIGINT` do that too, with no successor. A second signal exits at once.

|                         | default | what it does |
| ----------------------- | ------- | ------------ |
| `SB_DRAIN_SECONDS`      | 10      | the longest a draining process stays, then it exits. |
| `SB_DRAIN_QUIET_MS`     | 200     | a connection that saw traffic this recently still counts as busy. |
| `SB_EXEC_PATH`          | its own file | what `SIGUSR2` starts. Set it when you deploy to `releases/<id>/app` behind a `current` symlink: the running file is the old release. |

"In flight" is read from the kernel for each connection: unread or unsent
bytes, a request that arrived and has no answer yet, or traffic in the last
`SB_DRAIN_QUIET_MS`. An idle keep-alive connection is not busy and is closed
when the process exits. One case is not covered: a handler that waits longer
than `SB_DRAIN_QUIET_MS` on something that is not a socket, a bare
`setTimeout`, say, while its request sits unanswered. That connection looks
like the one a request is waiting on, so it is waited for; but the timer is
not, so raise `SB_DRAIN_SECONDS` rather than `SB_DRAIN_QUIET_MS` for handlers
that do that.

The one thing neither mechanism changes is the gap itself. A standalone binary
holds its SQLite files exclusively (see "Concurrency and scaling"), so the new
process cannot initialise until the old one has exited: for the length of the
drain plus the new binary's start-up (milliseconds to a couple of hundred
milliseconds for a small app, longer under a long request) a request waits in
the queue instead of being answered. It is delayed, not failed. Timers inside
the process (cron triggers, queue batches, Durable Object alarms) do not run in
the gap, as in any restart. With
`SB_SQLITE_EXCLUSIVE=0` nothing holds the files and you can run two copies at
once, but the zero-drop guarantee does not need it, and it costs the speed the
exclusive lock buys.

Measured on a 2-core Linux x86_64 box with three fresh-connection and three
keep-alive clients hammering one port while the binary is replaced: 200 swaps by
`systemctl restart` served 115,386 requests with 0 failed, 200 swaps by
`kill -USR2` served 134,272 with 0 failed, and 100 swaps of an app writing to D1
on every other request lost none of 32,128 acknowledged writes. A swap takes a
median of 80 ms; the slowest request in the run waited 101 ms. The old recipe
(start the new copy on the same port, then `SIGTERM` the old) failed 134 of
283,966 requests over 200 swaps and needed 597 retries.
The harness is `packages/runtime/test/standalone-restart-stress.py` in the
sproutboat-packages repository.

### On a VPS: systemd

`--deploy-files` writes the two units and a script next to the binary:

```sh
sproutboat build --standalone --deploy-files
./dist/app.deploy/deploy-vps.sh user@host      # scp + install + restart, first time and every time
```

`deploy-vps.sh` copies the binary to `/opt/<name>/<name>` (atomically, so the
running file is never half written), installs `<name>.socket` and
`<name>.service`, and runs `systemctl enable --now <name>.socket` and
`systemctl restart <name>.service`. The units:

```ini
# /etc/systemd/system/notes.socket
[Socket]
ListenStream=8080
Backlog=4096
TriggerLimitIntervalSec=0
[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/notes.service
[Unit]
Requires=notes.socket
[Service]
ExecStart=/opt/notes/notes
StateDirectory=notes
Environment=SB_DATA_DIR=/var/lib/notes
EnvironmentFile=-/etc/notes.env
DynamicUser=yes
KillSignal=SIGTERM
Environment=SB_DRAIN_SECONDS=20
TimeoutStopSec=30
Restart=on-failure
```

`TriggerLimitIntervalSec=0` matters: by default systemd gives up on a socket
that triggers more than 200 starts in 2 seconds and closes it, and under load a
restart can do that. Every later deploy is the same command: `build`, then `deploy-vps.sh`. Secrets
go in `/etc/notes.env` (`KEY=value` per line, mode 0600), never in the binary.
TLS is yours: Caddy or nginx on :443 proxying to `127.0.0.1:8080`. The socket
listens on every address by default; use `ListenStream=127.0.0.1:8080` when a
proxy on the same box is the only client.

Without the script: `scp dist/app host:/tmp/app.new && ssh host 'sudo install
-m755 /tmp/app.new /opt/notes/notes && sudo systemctl restart notes'`. If the
service has never started, `restart` starts it.

### Without systemd: `kill -USR2`

Run the binary under anything that does not restart it when its process exits
(tmux, runit with `down`, a launcher script), then to deploy:

```sh
scp dist/app host:/opt/notes/app.new && ssh host 'mv /opt/notes/app.new /opt/notes/app && kill -USR2 $(cat /run/notes.pid)'
```

`mv` replaces the file atomically (never copy over a running binary: Linux
refuses with "text file busy"). The running binary notices from
`/proc/self/exe` that its own file was replaced and starts the new one; it logs
`restart: started /opt/notes/app as pid N` and `drained, exiting`. The successor is
the old process's child that outlives it, so a supervisor that tracks the
original pid sees the service end: use this where the supervisor does not
restart on exit, or use systemd.

If the new binary cannot start at all (a missing execute bit, a wrong
architecture), the old one keeps serving and logs why. If it starts and then
dies during initialisation, nothing is listening and the socket is gone with
the process that held it: test a new binary (for example run it once on another
port against a copy of the data) before you send the signal.

## Containers

`--deploy-files` also writes a `Dockerfile` that is a scratch image: the binary
and an empty data directory, nothing else.

```dockerfile
FROM scratch
COPY --chown=65532:65532 data/ /data/
COPY --chown=65532:65532 --chmod=0755 notes /app/notes
ENV PORT=8080 SB_DATA_DIR=/data SB_DRAIN_SECONDS=8
EXPOSE 8080
VOLUME /data
USER 65532:65532
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/notes"]
```

```sh
sproutboat build --standalone --deploy-files
docker build -t notes dist/app.deploy
docker run -d -p 8080:8080 -v notes-data:/data notes
```

There is no shell, no libc and no certificate bundle, because the binary needs
none. The image is the size of the binary. `distroless/static` works the same
way if you want a `nonroot` user and `/etc/passwd` provided for you; `COPY` the
binary into it and set `USER nonroot`. For an arm64 image build with
`--target linux-arm64` and `docker build --platform linux/arm64`.

A container is replaced, not signalled, so a container restart cannot keep the
socket: the zero-drop part is the drain (`docker stop` sends `SIGTERM`, waits
ten seconds, and the binary answers what it has and leaves within
`SB_DRAIN_SECONDS`) plus whatever sits in front. Put the proxy or load balancer
in front, start the new container, then stop the old one, and the proxy's
health check moves traffic across with no connection reset.

## On Fly.io

```sh
sproutboat build --standalone --deploy-files
./dist/app.deploy/deploy-fly.sh iad      # creates the app and a 1 GB volume once, then fly deploy
```

Needs the `fly` CLI logged in. `fly.toml` is next to the script: port 8080 with
Fly's edge terminating TLS (the binary stays plain HTTP), `kill_signal =
"SIGTERM"` with a `kill_timeout` longer than `SB_DRAIN_SECONDS`, and a TCP
health check so a machine only takes traffic once the binary is listening.

State needs a volume, and a Fly volume attaches to one machine at a time, so a
deploy of a stateful app stops the machine and starts the new one: a few
seconds with no machine, however clean the drain. Fly's rolling deploy (start
the new machine, check it, stop the old) is zero-downtime only for an app with
no local state; for that, delete `[mounts]` and run two machines. If you need
state and no gap, keep it outside the binary (R2, an external database).

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

## Emitting the source without compiling

`sproutboat build --standalone --emit-only` runs the standalone build up to and
including the module Porffor would compile, then stops and prints its path:

```sh
sproutboat build --standalone --emit-only
# .sproutboat/porffor-units/linux-x86_64-embedded-release/sprout.generated.js
```

The file is byte for byte what a full `--standalone` build writes at the same
path: prelude, embedded transport, bindings and the bundled handler. Every check
that fails a build still fails this one, with the same message and exit code
(unsupported Node, Bun or Deno APIs, a handler without a default export, service
bindings, missing or oversized assets). Nothing native is acquired or compiled:
no Zig, SQLite, BearSSL, Porffor or uWebSockets, and no binary is written. It
suits tooling that inspects the wrapped source and never runs the binary.

One exception to byte identity: a project with a `version_metadata` binding
bakes the build time in, so two builds of it never match, emitted or not.
