# cf-cookies

Cloudflare's [Cookie parsing](https://developers.cloudflare.com/workers/examples/extract-cookie-value/) example: one named cookie, and a similar name is not a match.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/cf-cookies
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -H 'cookie: other=1; __uid=abc' localhost:8787/    # abc
curl localhost:8787/                                    # No cookie with name: __uid
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://cf-cookies.<team>.sproutboat.app
```
