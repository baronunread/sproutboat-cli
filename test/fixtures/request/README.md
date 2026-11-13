# request

`Request` as in Workers: `new Request(request, init)` keeps the method, headers and body unless `init` replaces them, and a body can be used once.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/request
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -X POST -H 'x-from: client' --data 'hi' localhost:8787/forward   # copies the incoming request
curl localhost:8787/rules                                              # what Workers enforces
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://request.<team>.sproutboat.app
```
