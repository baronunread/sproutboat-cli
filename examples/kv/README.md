# kv

KV, a key-value store: `get`, `put`, `delete` and `list`. The path is the key and the body is the value.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/kv-example
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -X PUT localhost:8787/hello -d 'world'
curl localhost:8787/hello            # world
curl localhost:8787/                 # the keys, one per line
curl -X DELETE localhost:8787/hello
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://kv-example.<team>.sproutboat.app
```

The first deploy creates the KV namespace and writes its id into `sproutboat.jsonc`; commit that change.
