# cf-headers

Cloudflare's [Set security headers](https://developers.cloudflare.com/workers/examples/security-headers/) example. It sets the headers on its own response instead of on a fetched origin response.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/cf-headers
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -i localhost:8787/              # Protected page, with nosniff, DENY, no-referrer and a CSP
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://cf-headers.<team>.sproutboat.app
```
