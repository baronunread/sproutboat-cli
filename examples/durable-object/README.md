# durable-object

Durable Objects: one addressable instance per name, with its own storage. `Counter` extends `DurableObject`, the Worker calls its `increment()` method over RPC (`env.COUNTERS.getByName(name)`), and an alarm runs after the traffic stops.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/durable-object
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl localhost:8787/downloads        # downloads: 1
curl localhost:8787/downloads        # downloads: 2, the same object
curl localhost:8787/signups          # signups: 1, another object
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://durable-object.<team>.sproutboat.app
```

Durable Objects need no provisioning: the class is exported from the entry module and named under `durable_objects`.
