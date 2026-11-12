# kitchen-sink

One Workers module that uses every Sproutboat binding, with a dashboard that
calls each one for real, and the conformance suite both backends are held to.

```
src/index.js                    the worker: /api routes, ChatRoom Durable Object, scheduled and queue handlers
public/                         the dashboard: index.html, app.css, app.js, fonts (no framework, no build step)
build-web.ts                    public/ -> site/, plus site/build-info.json (sizes, config, code excerpts)
conformance.ts                  the binding checks, run against the broker and standalone backends
r2-roundtrip.ts                 sha256 round trips of 5 MB and 25 MB files, run by conformance.ts or against a deployed app
harness.ts                      broker backend: host sprout + in-process broker (105 checks)
harness-standalone.ts           one binary with the bindings compiled in (same checks)
worker.test.ts                  the worker in-process with a clock the test moves: file expiry, the daily quota, Content-Disposition, /healthz (`bun test`)
serve.ts                        like harness.ts, but stays up for the browser
sproutboat.jsonc                the Cloud config (with the service binding)
sproutboat.standalone.jsonc     the same app without the service binding, for `build --standalone`
```

## The dashboard

Open `/` and every tile is live. Each one has a binding chip, the server time of
its last request, and a **Code** button that opens the handler that runs. The
excerpt is copied from `src/index.js` between `// #region` markers when the page
is built, so the code on screen is the code in the file. The panel floats over
the page, so opening one never changes a row's height. Neither does anything a
visitor does: every list, log and message line has a fixed size and truncates or
scrolls inside it, so a tile is as tall empty as full.

| Tile | Binding | What it shows |
| --- | --- | --- |
| KV counter | `env.SESSIONS` | `get` then `put` on one key; the two operations are timed separately. A read-modify-write on KV is not atomic, and the tile says so. |
| D1 guestbook | `env.DB` | Sign the guestbook, see the rows, and the SQL that ran with its bound values, time and rows read. |
| R2 upload | `env.UPLOADS` | Upload any file, up to 25 MB (`MAX_UPLOAD_BYTES`), with a progress bar and a Cancel; images get a thumbnail, other files an icon and a size. 50 files and 200 MB in all (`MAX_TOTAL_BYTES`). A file is deleted an hour after its upload (`FILE_TTL_SECONDS`) and the list shows when. 100 MB per address a day. Stored as 1 MiB R2 objects and streamed back with Range support (below). |
| Chat room | `env.ROOM` (Durable Object) | A WebSocket to one `ChatRoom` object, using the hibernation API (`acceptWebSocket`, `webSocketMessage`, `webSocketClose`, socket attachments). Last 30 messages are kept in the object's storage (30 × at most 4 KB, so about 120 KB at the very most). A frame cap, a message rate per connection and a connection cap per address protect it (below). The list is a box of one size that scrolls inside itself; it follows new messages only while the reader is at its end (or wrote the message), else a "N new messages" button floating over it takes them there. Long messages (up to 1,000 characters, line breaks kept), URLs and names wrap. The message box grows to five lines and then scrolls, Enter sends and Shift+Enter starts a new line. A page that loses its connection goes back by itself (backoff of 0.5 to 30 s with jitter, at once when the tab is shown again or the network returns) and the room's history on join puts back what it missed; when the room closed the socket on purpose (too many refused frames, a policy close, a full room) it says why and waits for the Reconnect button. |
| Queue and cron feed | `env.EMAILS`, `triggers.crons` | Enqueue a job; the `queue()` handler writes an event to D1. The cron handler writes one per run. The feed reads those events back. |
| Service binding | `env.PEER` | `env.PEER.fetch()` to `quote-service`. If the callee is unreachable the tile shows the error. A build without the binding says "Not in standalone". |
| Secrets | `env.ADMIN_TOKEN` | Declared secret names and whether each has a value, never the value. A token you type is compared inside the worker (`env.THROTTLE` allows 3 checks a minute per address). |
| Request log | none | The requests this tab made, with the server time of each. |

### Where the numbers come from

Nothing on the page is estimated.

- **Server time** is `Date.now()` (whole milliseconds) around the whole `fetch` handler, returned in a
  `Server-Timing: app;dur=...` header and as `ms` in the JSON. The tile latencies, the p50 and
  p99 cards and the chart are built from those values for the requests this tab has made. The
  chat tile shows the room's own handling time, and the client times the round trip itself.
- **Requests served** is the Analytics Engine data point count (`env.METRICS.query`), one per request, for all visitors.
- **Worker module and Static assets** are file sizes measured by `build-web.ts`
  and written to `site/build-info.json`. The binary's size is not shown live: it depends on the
  target and on `--release`, and `sproutboat build --standalone` prints it. The page links the
  measured figures in [docs/standalone.md](../../docs/standalone.md).
- **Memory per app (about 200 KB on Cloud)** is a labelled fact from the density test, not a live reading. The runtime does not expose per-app memory to the app.
- The queue time shown for a job is its wait in the queue plus the handler.

## A public demo: limits, caps and the daily reset

This app is deployed where strangers use it, so it defends itself. None of this
needs a binding beyond what the app already declares.

### Rate limits

Every limit is a budget **per client address** (see "Which address" below), kept in
a rate-limiter binding. A refused call answers `429` with a `retry-after` header and
`{ "error": "slow down: ... Try again in N s.", "code": "rate_limited", "retry_after": N }`;
the page turns that into a countdown on the tile and pauses its buttons.

| Routes | Limit | Binding and key |
| --- | --- | --- |
| Every route that writes: `POST /api/guestbook`, `POST /api/kv/incr`, `PUT` and `DELETE /api/r2`, `POST /api/queue/enqueue`; the conformance routes `POST /login`, `POST /notes`, `GET /notes/:id` (it counts a view), `POST /notes/:id/attach`, `POST /r2/direct-upload`; the calls that cost CPU or go out: `GET /api/quote`, `/quote`, `/peer`, `/egress`, `/hash`, `/throttle` | 30 a minute, all of them together | `WRITES`, `w:<address>` |
| One chunk of a file upload (`PUT /api/r2/chunk`), instead of the line above; `POST /notes/:id/attach` and `POST /r2/direct-upload` count here as well as above | 60 a minute (a 25 MB file is 25 requests) | `BULK`, `b:<address>` |
| Bytes in an hour, per address: uploads (charged by the size a file says it has, when its first chunk arrives) and downloads (charged by what a response sends) | 100 MB up, 250 MB down | a row in D1 (`quota`), key `up:<address>:<hour>` / `down:<address>:<hour>`; a refusal is a 429 with `code: "quota"`, `window: "hour"` and the seconds to the next hour |
| Bytes in a day, per address: uploads, charged the same way as above, from 04:00 UTC to 04:00 UTC (the daily reset's day, so the reset never hands out a second allowance) | 100 MB up (`MAX_UPLOAD_PER_DAY`) | a row in D1 (`quota`), key `upday:<address>:<day>`; a refusal is a 429 with `code: "quota"`, `window: "day"` and the seconds to 04:00 UTC |
| The secret check (`POST /api/secrets/check`) and a wrong `x-admin-token` | 3 a minute | `THROTTLE`, `secret-check:<address>` and `admin-token:<address>` |
| The dashboard's GET routes (`/api/*`, `/whoami`, `/notes`, `/attachments`, `/attach/:key`, `/r2/direct-download`) | 240 a minute | `READS`, `r:<address>` |
| Opening the chat socket (`GET /api/chat`) | 30 a minute | `WRITES`, `ws:<address>` |
| Chat frames, per connection | 3 a second and 12 per 10 s; 8 refusals close the socket (code 4008: a Durable Object socket may close with 1000 or 3000 to 4999 only) | counted in the `ChatRoom` object, in the socket attachment |
| Chat connections | 5 per address, 60 in the room | counted in the `ChatRoom` object |

The page and its assets are not limited. The limits are in `sproutboat.jsonc`
(`ratelimiters`); `gate()` in `src/index.js` applies them.

### Which address

`request.cf.clientIp` is the TCP peer. Behind Sproutboat Cloud's Caddy that is
Caddy's own loopback address, so it cannot tell visitors apart; Caddy sets
`X-Forwarded-For` and replaces any value a client sent. `clientIp()` therefore uses:
a public peer address as it is (a standalone binary reached directly), else the
**last** `X-Forwarded-For` entry when the peer is a private or loopback address (a
proxy in front), else one shared key, so the limits become a global cap rather than
disappearing. IPv6 clients are keyed on their /64. `GET /api/info` returns
`client_key` (`peer`, `x-forwarded-for`, `peer-private` or `none`) so a deployment can
check which one it got. The conformance suite gives each run its own address with
that header, so runs never share a budget.

### Input caps

Every input is validated and answered with a `4xx` and a JSON `error`, never a `500`
(an unexpected failure is logged and answered with a bare "internal error").

| Input | Cap | Over the cap |
| --- | --- | --- |
| JSON bodies | 4,096 characters (secret check 1,024, notes 8,192) | 413 |
| Guestbook name, message | 20 and 60 characters, text only, required | 400 |
| Queue label | 40 characters, text only | 400 |
| Secret token | 256 characters | 400 |
| Chat name, message, frame | 20 characters, 1,000 characters (an emoji counts as one) and 4,096 bytes (1,000 four-byte characters and the JSON around them fit) | an `error` frame |
| File name | 64 characters; anything but letters, digits, `.`, `-`, `_` becomes `_` | 400 |
| File size | `MAX_UPLOAD_BYTES` (25 MB), said in the first chunk and checked before any byte is stored; the page refuses a bigger file before it reads it; every chunk is exactly 1 MiB but the last, and its size is checked | 413 / 400 |
| Files in the bucket | 50 in `files/` | 409 |
| Bytes in the bucket | `MAX_TOTAL_BYTES` (200 MB), every object counted; tickets for direct uploads are cut to what is left | 409 |
| Bytes per address and hour | 100 MB up, 250 MB down | 429 |
| Bytes per address and day | 100 MB up | 429 |
| How long a file lives | `FILE_TTL_SECONDS` (3600): after that it is not served (404) and is deleted | 404 |
| Note title, body | 200 and 4,000 characters | 400 |
| `?key=` of `/throttle`, `?to=` of `/egress`, `?key=` of `/r2/direct-download` | 64, 2,048 and 256 characters; `/egress` takes only `http://` and `https://` | 400 |

Names and messages are tidied before they are stored: control characters become a
space, bidirectional overrides and unpaired surrogates are dropped, runs of spaces
collapse. Nothing is cut in the middle of an emoji.

### Large files

A file is a manifest object, `files/<name>` (no body; size, type, chunk count and an upload id are its
custom metadata), and its bytes are `chunks/<id>/000000`, `000001`, ... of 1 MiB each. The page sends one chunk per
request (`PUT /api/r2/chunk?name=&id=&n=&count=&total=&type=`, the body is the chunk, progress from
`XMLHttpRequest`); the last one checks that every chunk is there and writes the manifest. A download reads one
chunk per pull of a `ReadableStream`, so Range works: `206`, `Content-Range`, `416` outside the file, `Accept-Ranges`.
A file is served with the type it was uploaded with, `x-content-type-options: nosniff`, and a CSP of
`default-src none; sandbox`; only images (not SVG), audio and video are shown in the browser, every
other type, PDF, text, SVG and HTML included, is `content-disposition: attachment`, so the demo does not host documents or
pages for anyone.

**A file lives an hour.** The manifest carries `expires` (the upload's end plus `FILE_TTL_SECONDS`, 3600). After that
`GET /api/r2/file` answers 404 and the file is deleted, chunks and all. Deletion happens when anyone lists the files,
fetches the file or starts an upload, and in the `*/15 * * * *` cron (`purgeExpired()`), which also removes the chunks of
uploads nobody finished. The list (`GET /api/r2`) carries each file's `expires` in epoch milliseconds, and the page shows the minutes
left. A file may be cached by the browser only for what is left of its hour.

**One response sends at most `MAX_RESPONSE_BYTES` (2 MiB).** Reading a chunk costs about seven times its size
in worker memory (measured on the host sprout: a 10 MB download peaks at 85 MB, a 25 MB one at 246 MB, a 1 MiB
range at 14 MB), and none of it is collected until the response ends. Sproutd gives an app 32 MiB. So a plain
`GET` of a bigger file answers `413` with `code: "range_required"`, a longer Range is cut to the window (the
`Content-Range` says how much came), and a browser fetches the rest the way it does for video (`bytes=N-`). The
page downloads a big file the same way, window by window, and saves it as one file. Where memory is not capped
(a standalone binary, an app given more memory) raise `MAX_RESPONSE_BYTES` and a whole file streams in one response.

`bun r2-roundtrip.ts <url>` uploads and reads back binary, PNG and JPEG files of 5 MB and 25 MB (plus the 256-byte
fixture, an SVG, a PDF, a text file, an HTML file and an empty file), compares sha256 and checks Range, `416`, the type, the disposition, the expiry in the list and the CSP;
`conformance.ts` runs the same function against the broker and the standalone binary. Against a deployed app it
uploads 90 MB from one address, out of the 100 MB a day an address may upload: run it once a day (`--sizes 5` is 15 MB).

### Where the platform limits are

What an upload or a download meets on Sproutboat Cloud (Caddy, then the Cloud edge, then sproutd), with the file and
line where each value lives. The numbers are read from the sources (sproutboat-cloud, the edge-rs binary it runs,
sproutd), not measured on Cloud:

| Layer | Limit | Where |
| --- | --- | --- |
| Caddy, the account's app hostname | none (a plain `reverse_proxy`) | sproutboat-cloud `docs/app-hostnames.md` (the drop-in) |
| Cloud edge (edge-rs, backend mode) | 5 GiB request body, 413 by Content-Length; 30 s per request; 512 MiB response | `services/edge-rs/src/config.rs` 110-146 and 143 (`SPROUTBOAT_EDGE_MAX_BODY_BYTES`, `SPROUTBOAT_REQUEST_TIMEOUT_MS`), `src/proxy.rs` 372 and 1076, in the platform repo at `4fcf276` |
| sproutd request body | 100 MiB streamed, 413 above it by Content-Length, from compatibility date 2026-10-27; 1 MiB buffered before that | `src/native-host.cpp` 72 (`BODY_STREAM_MAX`), 2530 and 2551 |
| sproutd, per app | 32 MiB of memory, 30 s per request, 2 s of CPU without an answer | sproutd `README.md` "Limits" |
| R2 `get()` | reads the whole object into memory; `range` slices it afterwards | `inputs/shared-prelude.js` 11543 (`r2.get`) and 17496 (`range` slices the whole body), sproutd at `1e90348` |
| R2 transfer tickets (`createUploadUrl`, `createDownloadUrl`) | the ticket is made, but **nothing serves `/__sb/r2/transfer/...` on sproutd**: the native host forwards every path to the app, which answers 404 | `src/native-host.cpp` 2567 (`frontend.any("/*")`, no transfer route), against `vendor/toolchain/patch.ts` 686-703, which adds it to the standalone native server only. The Cloud edge returns at `proxy.rs` 411 (backend mode), before its own direct-transfer branch at 469, so it does not special-case them either |

So a 25 MB upload fits (25 requests of 1 MiB, each far under every limit), and a 25 MB download fits only as
Range windows: tickets and a single streamed response do not work on sproutd today.

### Health check

`GET /healthz` answers `200 {"ok":true,"at":<epoch ms>}` with `cache-control: no-store`; `HEAD` answers 200 with no body and any other method 405. It is
answered by the worker alone: it reads no D1, KV or R2, writes no analytics point and has no rate limit, so polling it every minute costs
next to nothing and never uses up a visitor's budget. A `200` means the app is up and serving. It does not mean the bindings work: for that
the dashboard's own routes (`GET /api/info`, `GET /api/r2`) are the check.

An external uptime monitor (Better Stack, UptimeRobot, a Cloudflare health check or a `curl` in cron) should:

- poll `https://<app host>/healthz` with `GET` (or `HEAD`) every 1 to 5 minutes, from more than one region if it can;
- call it down when the status is not `200`, the body does not contain `"ok":true`, or there is no answer within 5 seconds;
- alert after two failed polls in a row, not one, so a restart does not page anyone.

```sh
curl -fsS --max-time 5 https://<app host>/healthz | grep -q '"ok":true' || echo "kitchen-sink is down"
```

This repository does not create the monitor: an external account for it is the operator's to make.

### Cleanup

The demo data does not grow forever. The page says so: "Demo data resets daily at 04:00 UTC".

| What | How |
| --- | --- |
| Every 15 minutes (cron `*/15 * * * *`, told apart by `event.cron`) | `purgeExpired()` and `sweepChunks()`: files whose hour is up (manifest and chunks), and chunks over an hour old whose upload never finished. Its `scheduledTime` is its clock. |
| Daily at 04:00 UTC (cron `0 4 * * *`, told apart from `*/1 * * * *` by `event.cron`) | `dailyReset()`: every R2 object (any prefix: manifests, chunks, attachments), every KV key (sessions and the counter), the guestbook back to its three seed rows, notes, email log, heartbeats, view roll-ups and the queue feed, and the chat history in the `ChatRoom` object (connected pages are sent an empty history), and the spent hourly and daily allowances. |
| Between resets | guestbook 200 rows, notes 200, events 200, heartbeats 200, email log 200, view roll-ups 200; chat 30 messages; sessions expire after an hour and the `*/1` cron prunes them; files 50 and 200 MB, each deleted an hour after its upload; chunks of an upload nobody finished are deleted after an hour (the `*/15` cron), spent hourly allowances after two hours and daily ones after two days (the `*/1` cron). |
| Not reset | Analytics Engine data points (the app can write them, not delete them) and the `ViewCounter` objects (a few bytes each, one per note id). |

## Routes

The conformance routes are unchanged, and `conformance.ts` still checks them:

```
GET  /                     the dashboard (env.ASSETS), unknown GET paths fall back to it
POST /login                -> { token }              (KV put)
GET  /whoami               Bearer token              (KV get)
POST /notes { title, body} -> { id }                 (D1 insert + EMAILS.send)
GET  /notes                                          (D1 all)
GET  /notes/:id            -> { note, views }        (D1 first + DO increment)
POST /notes/:id/attach     raw body is the file      (R2 put + D1 update)
GET  /attach/:key                                    (R2 get, sha256 httpEtag)
GET  /attachments                                    (R2 list)
GET  /quote                                          (outbound fetch)
GET  /peer                                           (service binding)
GET  /hash, /throttle, /egress, /async               crypto.subtle, rate limiter, egress refusals, async handler
GET  /admin/stats          header x-admin-token      (secret gate; one number per binding)
```

Every route above, and every `/api` route below, answers `429` over its limit (see the table above). The dashboard adds these under `/api`:

```
GET  /healthz                         { ok: true }: for an uptime monitor (below), no rate limit
GET  /api/info                        bindings in this build, request count, the limits
GET  /api/kv       POST /api/kv/incr
GET  /api/guestbook  POST /api/guestbook {name, msg}
GET  /api/r2       PUT /api/r2?name=  DELETE /api/r2?name=   GET /api/r2/file?name=
GET  /api/queue    POST /api/queue/enqueue {label}
GET  /api/quote
GET  /api/secrets  POST /api/secrets/check {token}
GET  /api/chat                        WebSocket upgrade to the ChatRoom object
```

## Run it

```sh
cd examples/kitchen-sink
bun run build                         # public/ -> site/ (the harnesses and serve.ts do this too)
bun run test                          # harness.ts, the broker backend
bun run dev                           # serve.ts: stays up on http://127.0.0.1:8787, stub quote service included
```

With the CLI from this repository:

```sh
bun ../../src/main.ts dev --port 8787     # run from examples/kitchen-sink; the quote tile shows its error state
bun ../../src/main.ts build --standalone -c sproutboat.standalone.jsonc --target host
```

`sproutboat dev` has no edge, so the service binding cannot reach another app and
the quote tile shows the error state. `serve.ts` points the binding at a stub that
answers like `quote-service`, which is the way to see the success state locally. The
admin token is `s3cr3t-admin` under `serve.ts` and the harnesses; under `sproutboat
dev`, put `ADMIN_TOKEN=...` in a `.dev.vars` file next to `sproutboat.jsonc`.

The chat needs the WebSocket upgrade to reach the app. `sproutboat dev` relays it
through its stable port, and the platform edge proxies it.

## Deploy it with quote-service

The service binding calls another deployment, so deploy that one first.

```sh
cd examples/quote-service && sproutboat deploy      # the callee: GET /random and a random() RPC method
cd ../kitchen-sink
sproutboat secrets put ADMIN_TOKEN                  # optional: the Secrets tile reads it
bun run deploy                                      # bun run build && sproutboat deploy
```

`sproutboat.jsonc` binds `PEER` to the service named `quote-service`, and both
configs use compatibility date 2026-11-18, which service bindings between Cloud
apps need. A service binding must point at a different deployment: one sprout
serves one request at a time, so a binding back to the same app would wait on
itself.

## Standalone

```sh
sproutboat build --standalone -c sproutboat.standalone.jsonc          # linux-x64
sproutboat build --standalone -c sproutboat.standalone.jsonc --target host
PORT=3000 ADMIN_TOKEN=change-me ./dist/kitchen-sink
```

A binary has no edge, so the build refuses `services`. `sproutboat.standalone.jsonc`
is the same app without that entry; the quote tile sees that `env.PEER` is missing
and shows "Not in standalone". Everything else runs in the binary, including the
WebSocket chat, the queue consumer and both cron timers. The rate limiters key on
`x-forwarded-for` only when the peer is private, which is the case behind a proxy.

`bun run kitchen-sink:standalone` (`harness-standalone.ts`) runs the same checks
against a standalone binary, with the service binding dropped from the config in
memory.

## Notes

- The tile handlers take `env` as an argument and use only Workers APIs, so they run on
  Cloudflare Workers as they are. The entry points (`fetch(request)`, `scheduled(event)`,
  `queue(batch)`) read the global `env`, because the broker harness compiles without a
  compatibility date and so is not handed `env` as an argument.
- The KV counter lives under the `counter:` prefix; the cron job that prunes
  sessions skips that prefix.
- The R2 tile sends the file as text. Large or binary files belong behind
  `createUploadUrl` (see `POST /r2/direct-upload`), which the conformance suite covers.
- Hibernation (the worker is unloaded while a socket idles) is something sproutd
  does from compatibility date 2026-11-01. Locally the same API runs, and nothing hibernates.
- The fonts are Figtree and JetBrains Mono, served from `public/fonts` under the SIL
  Open Font License 1.1; the licence texts sit beside them.
