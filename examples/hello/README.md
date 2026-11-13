# hello

The smallest app: one `fetch` handler and one var (`GREETING`, from `sproutboat.jsonc`). No bindings.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/hello
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl localhost:8787/
# Hello, world!

curl 'localhost:8787/?name=sprout'
# Hello, sprout!
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://hello.<team>.sproutboat.app
```
