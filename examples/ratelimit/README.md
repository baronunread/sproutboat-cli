# ratelimit

Rate limiting: `env.API.limit({ key })` allows 3 calls per 60 seconds per key (set in `sproutboat.jsonc`). The Workers API reports only `success`, so a refusal sends `Retry-After` with the whole period; Sproutboat also returns `resetAt` (kitchen-sink uses it) for an exact value.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/ratelimit
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
for i in 1 2 3 4; do curl -i localhost:8787/limited; done   # the 4th is a 429 with retry-after
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://ratelimit.<team>.sproutboat.app
```
