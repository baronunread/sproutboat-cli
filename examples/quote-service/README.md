# quote-service

The peer of [`kitchen-sink`](../kitchen-sink): a Worker written as a class (`WorkerEntrypoint`) that answers HTTP and exposes `random()` over RPC, which a service binding calls as `await env.PEER.random()`. Deploy it first, then `kitchen-sink`, whose `PEER` binding names it (service bindings between Cloud apps need compatibility date 2026-11-18 or later).

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/quote-service
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl localhost:8787/                 # what this service is
curl localhost:8787/random           # { "content": "...", "author": "..." }
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://quote-service.<team>.sproutboat.app
```
