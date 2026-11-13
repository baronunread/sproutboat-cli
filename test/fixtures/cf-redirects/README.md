# cf-redirects

Cloudflare's [Bulk redirects](https://developers.cloudflare.com/workers/examples/bulk-redirects/) example. Cloudflare's version falls through to an origin for a path that is not mapped; this one answers 404, because it has no origin.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/cf-redirects
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -i localhost:8787/old-guide     # 301 to /guide
curl -i localhost:8787/unknown       # 404
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://cf-redirects.<team>.sproutboat.app
```
