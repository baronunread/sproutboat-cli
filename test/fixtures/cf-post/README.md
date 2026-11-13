# cf-post

Cloudflare's [Read POST](https://developers.cloudflare.com/workers/examples/read-post/) example: JSON and text bodies, invalid JSON and an unsupported content type. It does not read form data.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/cf-post
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -X POST -H 'content-type: application/json' -d '{"message":"hello"}' localhost:8787/
# {"received":{"message":"hello"}}

curl -X POST -H 'content-type: text/plain' -d 'hello' localhost:8787/        # hello
curl -X POST -H 'content-type: application/json' -d '{' localhost:8787/     # 400, invalid JSON
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://cf-post.<team>.sproutboat.app
```
