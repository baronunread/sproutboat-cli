# outbound-fetch

Outbound `fetch()`: any public host works with no configuration, and a private or reserved address is refused before it connects.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/outbound-fetch
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl localhost:8787/                 # example.com answered with 200
curl -i localhost:8787/blocked       # 403: fetch() refused the cloud metadata address
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://outbound-fetch.<team>.sproutboat.app
```
