# conformance

The binding conformance fixture. It is **not an example**: nothing here is written to be read as a model, and the rules for examples ([`../README.md`](../README.md)) do not apply. It exists so both backends are held to one definition of what each binding does.

`kitchen-sink` used to carry these routes and vectors. They live here now, so the kitchen-sink demo is only what its dashboard uses, and an example never has code that exists for a test.

```
src/index.js                    the worker: root routes, a ViewCounter Durable Object, scheduled() and queue()
public/                         index.html (the page and SPA fallback) and binary-fixture.bin (every byte value once)
conformance.ts                  the checks, driven over HTTP: 34 on the broker, 37 on a standalone binary
harness.ts                      broker backend: host sprout + in-process broker + a stub upstream
harness-standalone.ts           one binary with the bindings compiled in (the same checks)
sproutboat.jsonc                every binding, with the service binding
```

The harnesses are a few lines each; the lifecycle (deadlines, steps, cleanup of this run's own children) is in [`../lib/backends.ts`](../lib/backends.ts), shared with `kitchen-sink`.

## Run it

```sh
bun run conformance              # the broker backend
bun run conformance:standalone   # one standalone binary
```

`bun run kitchen-sink` and `bun run kitchen-sink:standalone` run the kitchen-sink demo's checks and then these.

## What it covers

| Area | Routes | Checks |
| --- | --- | --- |
| Static assets | `/`, any unknown path, `/binary-fixture.bin` | html content type, SPA fallback, the 256 bytes unchanged (#176) |
| KV | `POST /login`, `GET /whoami` | a token round trip |
| D1 | `POST /notes`, `GET /notes` | insert, list, non-ASCII text (#189) |
| Durable Objects | `GET /notes/:id` | a view count that increments, and its alarm rolling up into D1 (#125) |
| R2 | `POST /notes/:id/attach`, `GET /attach/:key`, `GET /attachments`, `/r2/direct-*` | put, read back with an etag, list, and one-use transfer tickets (a 2 MiB PUT, a byte range, `If-None-Match`) |
| Queues | `POST /notes` enqueues | the consumer wrote its row |
| Cron | `scheduled()` | the trigger runs and writes a heartbeat (broker only: a standalone binary runs its own timers) |
| Outbound fetch | `/quote`, `/egress` | a proxied quote, the refusal of private addresses with the same words on both backends (#174), a redirect to one not followed |
| Secrets | `GET /admin/stats` | a bad token refused, the real one accepted |
| Analytics Engine | `/admin/stats` | `query()` reports the data points written |
| Service binding | `GET /peer` | `env.PEER.fetch()` reaches another deployment (broker only) |
| Crypto | `GET /hash` | SHA-256 and HMAC vectors, repeated HMAC over raw digest bytes (h1-regression), `crypto.scryptVerify` (#153) |
| Rate limiting | `GET /throttle` | 3 then a refusal, `resetAt` within one period |
| Async handlers | `GET /async` | a promise-returning handler is handed back untouched |

## Adding to it

A check that needs a route belongs here: add the route to `src/index.js` and the check to `conformance.ts`. Do not add it to an example, and do not add it to `kitchen-sink`, whose own checks (`../kitchen-sink/conformance.ts`) cover only what its dashboard does.
