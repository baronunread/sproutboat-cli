# waituntil

`ctx.waitUntil()`: work that must finish, but that the response does not wait for.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/waituntil
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl localhost:8787/                 # ok, immediately
curl localhost:8787/check            # the timestamp the background write stored
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://waituntil.<team>.sproutboat.app
```
