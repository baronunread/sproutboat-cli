# upload

Streaming request bodies: the handler counts an upload as it arrives, so memory stays flat however large it is.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/upload
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
head -c 50000000 /dev/zero | curl -X POST --data-binary @- localhost:8787/
# {"bytes":50000000,"chunks":...,"spreadMs":...}
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://upload.<team>.sproutboat.app
```
