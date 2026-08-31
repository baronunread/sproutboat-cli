# kitchen-sink

One Sproutboat app that drives **every binding**, with an **Astro** browser UI
and an end-to-end harness.

```
src/index.js     the Sproutboat worker (routes + DO class + scheduled/queue)
web/             the Astro UI  ->  built to web/dist, published as env.ASSETS
harness.ts       headless end-to-end check (18 assertions)
serve.ts         same, but stays up for the browser
```

| Binding | Where in the app | UI section |
| --- | --- | --- |
| `vars` | `env.SITE_NAME` (page title), `env.QUOTE_URL` | — |
| static assets | Astro `web/dist` (two pages — the app + `/about.html`, shared `Layout` + `Footer`) served via `env.ASSETS.fetch(request)` (`run_sprout_first: true`), SPA fallback for unknown paths | the page + footer links |
| `secrets` | `env.ADMIN_TOKEN` gates `GET /admin/stats` | **Admin** tab (demo password `s3cr3t-admin`) |
| KV | `env.SESSIONS` — `put` on `/login`, `get` on `/whoami`, `list`+`delete` in cron | header **Log in** button |
| D1 | `env.DB` — `notes`, `email_log`, `heartbeat` tables (`exec`/`prepare`/`bind`/`all`/`first`) | **Notes** tab |
| R2 | `env.UPLOADS` — `put` on attach (≤ ~900 KB in the demo; the native-fetch server caps request bodies at 1 MiB — large-object R2 is [issue #56](https://github.com/baronunread/sproutboat/issues/56)), `get` on download, `list` on `/attachments` | **Notes** tab (file input by *Add note*) + **Attachments** tab |
| Queues | `env.EMAILS.send()` on `POST /notes`; the `queue(batch)` handler logs to D1 | **Admin dashboard** (emails processed) |
| Durable Objects | `env.VIEWS` / `class ViewCounter` — atomic per-note view count via `state.storage` | **Notes** (open a note) |
| Analytics Engine | `env.METRICS.writeDataPoint()` every request; `env.METRICS.query()` feeds the dashboard | **Admin dashboard** (points + recent events) |
| outbound `fetch` | `fetch(env.QUOTE_URL)` on `/quote`, host must be in `outbound` | **Outbound fetch** |
| cron | `*/1 * * * *` → `scheduled(event)` prunes sessions + writes a heartbeat | **Admin dashboard** (heartbeats) |

## Routes

```
GET  /                     the UI (env.ASSETS) — unknown GET paths fall back to it
POST /login                -> { token }              (KV put)
GET  /whoami               Bearer token             (KV get)
POST /notes { title, body} -> { id }                 (D1 insert + EMAILS.send)
GET  /notes                                          (D1 all)
GET  /notes/:id            -> { note, views }        (D1 first + DO increment)
POST /notes/:id/attach     raw body is the file      (R2 put + D1 update)
GET  /attach/:key                                    (R2 get, sha256 httpEtag)
GET  /attachments                                    (R2 list)
GET  /quote                                          (outbound fetch)
GET  /admin/stats          header x-admin-token      (secret gate; one number per binding + analytics rows)
```

## Run it

```sh
cd examples/kitchen-sink
bun run dev      # serve.ts — stays up; open http://127.0.0.1:8787
bun run test     # harness.ts — 18 headless checks, one per binding
bun run deploy   # astro build + sproutboat deploy
```

`dev` / `test` build the Astro UI in `web/`, compile the worker with Porffor,
start `src/broker.ts` (the same one the supervisor spawns per deployment),
publish `web/dist`, and boot the binary. The admin password (`ADMIN_TOKEN`
secret) is `s3cr3t-admin`.

`deploy` is `bun run build && bunx sproutboat deploy` — Sproutboat only *copies*
`assets.directory`, so the site build runs first, Wrangler-style.

## On a VPS / container

The platform wiring is in `sproutboat/` (the self-hosted repo):
`services/supervisor/src/run.ts` spawns `services/broker/src/broker.ts` for any
artifact that ships a `bindings.json` (and passes `--assets-dir` when
`assets.json` is present), passing `SB_BROKER_PORT` / `SB_BROKER_TOKEN` to the
worker and `--worker-url` + `--data-dir` to the broker. Deploy this project with
the CLI against a self-hosted control plane and the same flow runs under systemd.
Secrets are read from a `secrets.json` next to the artifact (encryption at rest
is tracked in `baronunread/sproutboat#8`).
