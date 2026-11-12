# queue

Queues: a producer in `fetch()` and a consumer in `queue()`. `send()` returns once the message is stored; the batch reaches `queue()` out of band, and the consumer writes each message to D1.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/queue
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -X POST localhost:8787/ -H 'content-type: application/json' -d '{"email":"someone@example.com"}'
# queued

curl localhost:8787/                 # what the consumer stored, a moment later
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://queue.<team>.sproutboat.app
```

The first deploy creates the queue and the database and writes their ids into `sproutboat.jsonc`; commit that change. The same app is the consumer of its own queue.
