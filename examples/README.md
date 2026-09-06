# Examples

One binding each, small enough to read in a sitting. Every handler here is the
same code that runs on the deployed platform — `env` is a global, and every
binding call is synchronous.

| Example | Binding | What it shows |
| --- | --- | --- |
| [`hello`](hello) | — | the smallest handler: one `fetch`, no bindings |
| [`kv`](kv) | KV | `get` / `put` / `delete` / `list` |
| [`d1`](d1) | D1 | `prepare().bind().run()`, `.all()`, and a row id back |
| [`r2`](r2) | R2 | store an object, read it back with its etag, list a bucket |
| [`queue`](queue) | Queues | a producer in `fetch`, a consumer in `queue()` |
| [`cron`](cron) | Cron Triggers | `scheduled()` on a `*/1 * * * *` expression |
| [`durable-object`](durable-object) | Durable Objects | one instance per name, its own storage, an alarm |
| [`assets`](assets) | Static assets | files from a directory, with `/api/*` kept for the handler |

Two larger ones:

| | |
| --- | --- |
| [`kitchen-sink`](kitchen-sink) | every binding in one app, and the conformance suite both backends are held to |
| [`stress`](stress) | the memory and throughput baseline in [`BASELINE.md`](stress/BASELINE.md) |

## Running one

```sh
cd examples/kv
sproutboat dev                      # a real local broker, bindings and all
```

Or as a single file with nothing beside it:

```sh
sproutboat build --standalone
PORT=8080 ./dist/kv-example
```

## Checking them

```sh
bun run examples                    # build each one and drive it
bun run examples kv d1              # just these
```

The website's support table links each binding to the example that
demonstrates it, so this is what stops that table from claiming something no
longer true.
