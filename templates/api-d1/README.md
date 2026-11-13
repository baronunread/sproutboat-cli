# api-d1

A small JSON API on D1: tasks you can create, list, read, update and delete, with the schema in migrations and every input validated.

It is standard Cloudflare Workers TypeScript: the same files run on Cloudflare unchanged. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## What it shows

- Plain `fetch` routing: a `switch` on the method and one regular expression for `/tasks/:id`. At this size a router costs more than it saves.
- The schema in `migrations/0001_create_tasks.sql`, applied by `sproutboat d1 migrations apply DB`, not created by the Worker on its first request.
- Validation as plain functions from untrusted input to a typed value or a list of what is wrong (`src/validate.ts`), tested on their own. No library.
- Prepared statements with bound values only, `RETURNING` to get the row back in one round trip, and keyset pagination (`after=<id>`) that asks for one extra row instead of running a `COUNT`.
- Errors as `{ "error": { "code", "message", "details" } }` with the status that says what was wrong: 400, 404, 405 with `Allow`, 413, 415.

## Run it

```sh
npm install
sproutboat d1 migrations apply DB --local   # create the tables in the local database
sproutboat dev                              # http://localhost:8787, rebuilt on save
```

Or as one executable with its bindings inside it. A standalone binary keeps its database in `$SB_DATA_DIR/d1/DB.sqlite`, so apply the migrations to that directory first:

```sh
sproutboat build --standalone --target host
sproutboat d1 migrations apply DB --local --persist-to ./data
SB_DATA_DIR=./data PORT=8080 ./dist/api-d1
```

## Try it

```sh
curl -X POST localhost:8787/tasks -H 'content-type: application/json' -d '{"title":"read the docs"}'
curl localhost:8787/tasks?limit=2
curl -X PATCH localhost:8787/tasks/1 -H 'content-type: application/json' -d '{"done":true}'
curl localhost:8787/tasks?done=true
curl -X DELETE localhost:8787/tasks/1
```

A change to the schema is a new file: `sproutboat d1 migrations create DB add_due_date`, edit the `.sql` it writes, apply it. Never edit one that has been applied.

## Test it

```sh
npm test                             # unit tests for the validation, then the API against `sproutboat dev`
npm run typecheck
```

`npm test` applies the migrations to the local database before it starts the server. To drive a server that is already running (and already migrated), set `BASE_URL`. The tests use Node's own test runner (Node 22.18 or later runs the `.ts` files as they are).

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://api-d1.<team>.sproutboat.app
sproutboat d1 migrations apply DB --remote
```

The first deploy creates the D1 database and writes its id into `sproutboat.jsonc`; commit that change. There is no authentication here: put one in front of the write routes before you expose it.

## Moving to Wrangler

The config is `sproutboat.jsonc` today. It uses only keys that exist in a `wrangler.jsonc` with the same meaning (`name`, `main`, `compatibility_date`, `d1_databases`), and nothing in `src/` is Sproutboat-specific, so converting is mechanical: `d1_databases` becomes a list of `{ binding, database_name, database_id }`. The migrations are the same files; Wrangler reads `migrations/` too. Sproutboat is making `wrangler.jsonc` a native config; `sproutboat migrate` will then do the conversion for you.
