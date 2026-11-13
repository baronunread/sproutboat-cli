# site-api

A static front end and its API in one Worker: the files in `public/` are served as they are, and `/api/*` goes to the handler. The page is a small sign-up form that stores addresses in KV.

It is standard Cloudflare Workers TypeScript: the same files run on Cloudflare unchanged. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## What it shows

- `assets` with `run_sprout_first: ["/api/*"]`: the handler runs first for the API routes, so a file can never shadow one, and every other path is a file.
- `env.ASSETS.fetch(request)` to hand a request on to the files, and `not_found_handling: "404-page"` to answer a path with no file with `public/404.html` and a 404.
- A form that posts JSON to the same origin, with no CORS to set up.
- KV for the list: one key per address, so a repeated sign-up is a read and not a write, and a counter that cannot lose an update because there is none.
- Validation of the body and the method, and `cache-control: no-store` on API answers.

## Run it

```sh
npm install
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Or as one executable with the files and the bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/site-api
```

## Try it

```sh
open http://localhost:8787
curl localhost:8787/api/health                           # {"ok":true}
curl -X POST localhost:8787/api/subscribe -H 'content-type: application/json' -d '{"email":"ada@example.com"}'
curl localhost:8787/api/subscribers/count                # {"count":1}
curl -i localhost:8787/nope                              # 404, with public/404.html
```

Counting walks the list, which is fine for hundreds of addresses. For many more, keep a counter in a Durable Object and have the handler update it.

## Test it

```sh
npm test                             # starts `sproutboat dev` and drives the site and the API
BASE_URL=http://localhost:8080 npm test   # or drive a server that is already running
npm run typecheck
```

The tests use Node's own test runner (Node 22.18 or later runs the `.ts` files as they are).

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://site-api.<team>.sproutboat.app
```

The first deploy creates the KV namespace and writes its id into `sproutboat.jsonc`; commit that change.

## Moving to Wrangler

The config is `sproutboat.jsonc` today. It uses only keys that exist in a `wrangler.jsonc` with the same meaning (`name`, `main`, `compatibility_date`, `kv_namespaces`, `assets`), and nothing in `src/` is Sproutboat-specific, so converting is mechanical. Two spellings change: `kv_namespaces` becomes a list of `{ binding, id }`, and `run_sprout_first` becomes `run_worker_first`. Sproutboat is making `wrangler.jsonc` a native config; `sproutboat migrate` will then do the conversion for you.
