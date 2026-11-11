# kitchen-sink

One Workers module that uses every Sproutboat binding, with a dashboard that
calls each one for real, and the conformance suite both backends are held to.

```
src/index.js                    the worker: /api routes, ChatRoom Durable Object, scheduled and queue handlers
public/                         the dashboard: index.html, app.css, app.js, fonts (no framework, no build step)
build-web.ts                    public/ -> dist/, plus dist/build-info.json (sizes, config, code excerpts)
conformance.ts                  the binding checks, run against the broker and standalone backends
harness.ts                      broker backend: host sprout + in-process broker (38 checks)
harness-standalone.ts           one binary with the bindings compiled in (same checks)
serve.ts                        like harness.ts, but stays up for the browser
sproutboat.jsonc                the Cloud config (with the service binding)
sproutboat.standalone.jsonc     the same app without the service binding, for `build --standalone`
```

## The dashboard

Open `/` and every tile is live. Each one has a binding chip, the server time of
its last request, and a **Code** button that opens the handler that runs. The
excerpt is copied from `src/index.js` between `// #region` markers when the page
is built, so the code on screen is the code in the file. The panel floats over
the page, so opening one never changes a row's height.

| Tile | Binding | What it shows |
| --- | --- | --- |
| KV counter | `env.SESSIONS` | `get` then `put` on one key; the two operations are timed separately. A read-modify-write on KV is not atomic, and the tile says so. |
| D1 guestbook | `env.DB` | Sign the guestbook, see the rows, and the SQL that ran with its bound values, time and rows read. |
| R2 upload | `env.UPLOADS` | Upload a text file (up to `MAX_UPLOAD_BYTES`, 64 KB), list, download, delete. 50 files at most. |
| Chat room | `env.ROOM` (Durable Object) | A WebSocket to one `ChatRoom` object, using the hibernation API (`acceptWebSocket`, `webSocketMessage`, `webSocketClose`, socket attachments). Last 30 messages are kept in the object's storage. |
| Queue and cron feed | `env.EMAILS`, `triggers.crons` | Enqueue a job; the `queue()` handler writes an event to D1. The cron handler writes one per run. The feed reads those events back. |
| Service binding | `env.PEER` | `env.PEER.fetch()` to `quote-service`. If the callee is unreachable the tile shows the error. A build without the binding says "Not in standalone". |
| Secrets | `env.ADMIN_TOKEN` | Declared secret names and whether each has a value, never the value. A token you type is compared inside the worker (`env.THROTTLE` allows 3 checks a minute per visitor). |
| Request log | none | The requests this tab made, with the server time of each. |

### Where the numbers come from

Nothing on the page is estimated.

- **Server time** is `performance.now()` around the whole `fetch` handler, returned in a
  `Server-Timing: app;dur=...` header and as `ms` in the JSON. The tile latencies, the p50 and
  p99 cards and the chart are built from those values for the requests this tab has made. The
  chat tile shows the room's own handling time, and the client times the round trip itself.
- **Requests served** is the Analytics Engine data point count (`env.METRICS.query`), one per request, for all visitors.
- **Worker module and Static assets** are file sizes measured by `build-web.ts`
  and written to `dist/build-info.json`. The binary's size is not shown live: it depends on the
  target and on `--release`, and `sproutboat build --standalone` prints it. The page links the
  measured figures in [docs/standalone.md](../../docs/standalone.md).
- **Memory per app (about 200 KB on Cloud)** is a labelled fact from the density test, not a live reading. The runtime does not expose per-app memory to the app.
- The queue time shown for a job is its wait in the queue plus the handler.

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

The dashboard adds these under `/api`:

```
GET  /api/info                        bindings in this build, request count
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
bun run build                         # public/ -> dist/ (the harnesses and serve.ts do this too)
bun run test                          # harness.ts, the broker backend
bun run dev                           # serve.ts: stays up on http://127.0.0.1:8787, stub quote service included
```

With the CLI from this repository:

```sh
bun ../../src/main.ts dev --port 8787     # run from examples/kitchen-sink; QUOTES tile shows its error state
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
WebSocket chat, the queue consumer and the cron timer.

`bun run kitchen-sink:standalone` (`harness-standalone.ts`) runs the same checks
against a standalone binary, with the service binding dropped from the config in
memory.

## Notes

- The handlers use `fetch(request, env, ctx)`, `scheduled(event, env, ctx)` and
  `queue(batch, env, ctx)`, so the same file deploys to Cloudflare Workers apart from
  the Sproutboat-only pieces (the `/egress` and `/throttle` checks, `scryptVerify`).
- The KV counter lives under the `counter:` prefix; the cron job that prunes
  sessions skips that prefix.
- The R2 tile sends the file as text. Large or binary files belong behind
  `createUploadUrl` (see `POST /r2/direct-upload`), which the conformance suite covers.
- Hibernation (the worker is unloaded while a socket idles) is something sproutd
  does from compatibility date 2026-11-01. Locally the same API runs, and nothing hibernates.
- The fonts are Figtree and JetBrains Mono, served from `public/fonts` under the SIL
  Open Font License 1.1; the licence texts sit beside them.
