# r2

R2, S3-style object storage: `put`, `get` (with its etag and metadata), `list` and `delete`. Keep objects small here: a request body is stored in one put; `kitchen-sink` moves large files in 1 MiB chunks.

The handler is standard Workers code (`export default { fetch(request, env, ctx) }`, every binding call awaited), typed with `satisfies ExportedHandler<Env>`. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## Run it

```sh
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/r2-example
```

## Try it

The URLs are `sproutboat dev`'s; a standalone binary listens on the `PORT` you gave it (8080 above).

```sh
curl -X PUT localhost:8787/notes.txt -d 'the file contents'
curl -i localhost:8787/notes.txt     # the body, with its etag
curl localhost:8787/                 # key and size of every object
curl -X DELETE localhost:8787/notes.txt
```

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://r2-example.<team>.sproutboat.app
```

The first deploy creates the bucket and writes its id into `sproutboat.jsonc`; commit that change.
