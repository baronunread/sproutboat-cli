# cron

Cron Triggers: `scheduled(controller, env, ctx)` runs on the expressions under `triggers.crons`. This one counts ticks in KV, once a minute.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/cron
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl localhost:8787/
# 0 ticks, last at never
# ...a minute later, with no traffic in between:
# 1 ticks, last at 2026-11-18T09:01:00.000Z
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://cron.<team>.sproutboat.app
```

The first deploy creates the KV namespace and registers the cron expression.
