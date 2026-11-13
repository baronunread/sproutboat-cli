# jobs

Scheduled work with a queue in the middle: a cron trigger decides what to do and enqueues it, a queue consumer does it, and KV holds the state. Here the job is a daily digest: count the events recorded for a UTC date and store the totals.

It is standard Cloudflare Workers TypeScript: the same files run on Cloudflare unchanged. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

```
cron (every hour)  ->  scheduled()  ->  JOBS queue  ->  queue()  ->  KV
POST /jobs         ->  fetch()      ->  JOBS queue  ->  queue()  ->  KV      (the same path, by hand)
```

## What it shows

- `scheduled(controller, env)` that only enqueues: fast, and nothing can be half-done when it ends.
- `queue(batch, env)` that processes each message on its own, `ack()`s a success, `retry({ delaySeconds })`s a failure with a growing delay, and after three attempts records the failure where `GET /jobs/:id` shows it and acks, so it is not redelivered forever.
- Idempotence, because queues and cron are both at-least-once: the cron job's id is the hour, so a trigger that fires twice enqueues one job, and a redelivered message finds the job `done` and does nothing.
- KV as state: one key per event (so two events at the same instant cannot overwrite a count), job records with a TTL, and the stored digests.
- The cron path is tested by calling the handlers with small fakes (`test/handlers.test.ts`), because a test cannot wait for the hour.

## Run it

```sh
npm install
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/jobs
```

## Try it

```sh
curl -X POST localhost:8787/events -H 'content-type: application/json' -d '{"name":"signup"}'
curl -X POST localhost:8787/events -H 'content-type: application/json' -d '{"name":"signup"}'
curl -X POST localhost:8787/jobs -d '{}'                 # 202 {"id":"...","date":"2026-11-13"}
curl localhost:8787/jobs/<id>                            # queued, then done, with the digest
curl localhost:8787/digests/2026-11-13                   # {"total":2,"byName":{"signup":2},...}
```

The cron expression is in `sproutboat.jsonc` (`"0 * * * *"`, every hour on the hour, UTC). Change it there; nothing in `src/` repeats it.

## Test it

```sh
npm test                             # the handlers with fakes, then the whole path against `sproutboat dev`
BASE_URL=http://localhost:8080 npm test   # or drive a server that is already running
npm run typecheck
```

The tests use Node's own test runner (Node 22.18 or later runs the `.ts` files as they are).

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://jobs.<team>.sproutboat.app
```

The first deploy creates the KV namespace and the queue and writes their ids into `sproutboat.jsonc`; commit that change. A queue message that keeps failing is dropped after its attempts; if you cannot afford that, add a dead-letter queue and read it from a second consumer.

## Moving to Wrangler

The config is `sproutboat.jsonc` today. It uses only keys that exist in a `wrangler.jsonc` with the same meaning (`name`, `main`, `compatibility_date`, `kv_namespaces`, `queues`, `triggers.crons`), and nothing in `src/` is Sproutboat-specific, so converting is mechanical: `queues` becomes a `producers` and a `consumers` list for the same queue, and `kv_namespaces` a list of `{ binding, id }`. Sproutboat is making `wrangler.jsonc` a native config; `sproutboat migrate` will then do the conversion for you.
