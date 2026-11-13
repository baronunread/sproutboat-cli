# assets

Static assets: the files in `public/` are served from the edge or, in a standalone binary, from inside it, and `/api/*` stays with the handler (`run_sprout_first`). `env.ASSETS.fetch(request)` serves a file from the handler.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/assets
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl localhost:8787/                 # public/index.html
curl localhost:8787/api/time         # the handler
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://assets.<team>.sproutboat.app
```
