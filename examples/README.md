# Examples

Small enough to read in a sitting. Every handler here is the same code that runs on the deployed platform. Binding calls are synchronous. The `env` object is also passed as the second handler argument from compatibility date `2026-09-28`.

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

## Original Cloudflare Worker source

The [`workers-verbatim`](workers-verbatim) fixtures build the JavaScript from Cloudflare's Return JSON, Cookie parsing, and Redirect examples without handler edits. The native smoke harness checks their responses, along with the separate [`workers-contract`](workers-contract) fixture for `(request, env, ctx)`. The cookie example uses the original `cookie` import.

## Cloudflare Workers pattern ports

These reproduce the behavior of selected [Cloudflare Workers examples](https://developers.cloudflare.com/workers/examples/) in standalone Sproutboat binaries. They run in the same native smoke harness as the binding examples. The code is adapted for Sproutboat's handler contract, rather than copied verbatim.

| Sproutboat example | Cloudflare example | What the native check covers |
| --- | --- | --- |
| [`cf-json`](cf-json) | [Return JSON](https://developers.cloudflare.com/workers/examples/return-json/) | JSON body and content type |
| [`cf-cookies`](cf-cookies) | [Cookie parsing](https://developers.cloudflare.com/workers/examples/extract-cookie-value/) | Named cookie and similar-name rejection |
| [`cf-redirects`](cf-redirects) | [Bulk redirects](https://developers.cloudflare.com/workers/examples/bulk-redirects/) | Mapped path, Location header, and unmapped path |
| [`cf-headers`](cf-headers) | [Set security headers](https://developers.cloudflare.com/workers/examples/security-headers/) | Security headers on a local response |
| [`cf-post`](cf-post) | [Read POST](https://developers.cloudflare.com/workers/examples/read-post/) | JSON, text, invalid JSON, and unsupported content type |

There are intentional differences. Cloudflare's bulk redirect example falls through to an origin fetch for unmapped paths; this port returns 404 because it has no origin. The security headers port sets headers on its own response instead of modifying a fetched origin response. The POST port covers JSON and text, not form data.

The existing [`analytics`](analytics), [`cron`](cron), and [`outbound-fetch`](outbound-fetch) examples already cover the same basic operations as Cloudflare's analytics, Cron Trigger, and fetch examples. Streaming, WebSockets, and HTMLRewriter are outside Sproutboat's current handler surface. [Sign requests](https://developers.cloudflare.com/workers/examples/signing-requests/) needs a separate native test for its Node Buffer import and Unicode signing path.

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
