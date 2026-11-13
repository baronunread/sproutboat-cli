# Examples

Small enough to read in a sitting. Every example is a standard Cloudflare Worker: the same file runs on Workers wherever the binding exists there. Each directory has its own README with what it shows, how to run it, how to deploy it and the `curl` lines.

| Example | Binding | What it shows |
| --- | --- | --- |
| [`hello`](hello) | — | the smallest handler: one `fetch`, one var, no bindings |
| [`kv`](kv) | KV | `get` / `put` / `delete` / `list` |
| [`d1`](d1) | D1 | `prepare().bind().run()`, `.all()`, and a row id back |
| [`r2`](r2) | R2 | store an object, read it back with its etag, list a bucket |
| [`queue`](queue) | Queues | a producer in `fetch`, a consumer in `queue()` |
| [`cron`](cron) | Cron Triggers | `scheduled()` on a `*/1 * * * *` expression |
| [`durable-object`](durable-object) | Durable Objects | one instance per name, called over RPC, its own storage, an alarm |
| [`assets`](assets) | Static assets | files from a directory, with `/api/*` kept for the handler |
| [`analytics`](analytics) | Analytics Engine | `writeDataPoint()`, and the Sproutboat-only `query()` |
| [`ratelimit`](ratelimit) | Rate limiting | `limit({ key })` per window |
| [`vars-secrets`](vars-secrets) | vars, secrets | settings baked in, secrets supplied at launch |
| [`waituntil`](waituntil) | — | `ctx.waitUntil()` |
| [`outbound-fetch`](outbound-fetch) | — | `fetch()` to a public host, and the refusal of a private one |
| [`service-bindings`](service-bindings) | Services | `env.GREETER.fetch()` from one app to another |

This directory holds only what is meant to be read. Everything that exists for a test or a measurement is a fixture in [`test/fixtures`](../test/fixtures) (see "Fixtures" below), so nothing you read here is a conformance vector, a stress rig or a runtime comparison.

## Rules for examples

These two rules are what the examples are held to, in CI. A change that adds or edits an example follows them.

**1. Standard Workers style.** An example is code you could paste into a Cloudflare Worker.

- `export default { async fetch(request, env, ctx) { ... } } satisfies ExportedHandler<Env>`, with `scheduled(controller, env, ctx)` and `queue(batch, env, ctx)` for the other handlers. Durable Objects extend `DurableObject` from `cloudflare:workers`; a Worker written as a class extends `WorkerEntrypoint`.
- `env` is the handler's second argument, never a global. Every binding call is awaited, bodies are read with `await request.json()` / `await request.text()`, and `Response.json()` replaces a hand-rolled helper.
- The entry is TypeScript (`src/index.ts`) typed with the `Env` that `sproutboat types` writes into `worker-configuration.d.ts`. Commit that file; `bun run examples:types` checks it is current.
- `compatibility_date` is 2026-11-18, which has every standard form the examples use. One date keeps them comparable; it never goes below 2026-09-28, where `(request, env, ctx)` begins.
- Setup that happens once (a schema) happens once, not on every request.
- A Sproutboat-only API is allowed only where the example exists to show it, says so in its first comment and README, and is listed as a skip below with its reason. `analytics` (`query()`) and `outbound-fetch` (the private-address refusal) are the whole list.

`bun run examples:workerd` enforces it (CI runs it as the `examples-workerd` job): it translates each `sproutboat.jsonc` into a `wrangler.jsonc`, typechecks the entry against Cloudflare's own runtime types, runs it under workerd (`wrangler dev`) and sends the example's smoke requests. An example that only works on Sproutboat fails the build. An example that workerd cannot emulate locally may be skipped, but only by an entry in `WORKERD_SKIPS` in [`checks.ts`](checks.ts), with the reason; `bun test` (`src/examples-rules.test.ts`) fails if an example is neither checked nor listed.

**2. No test-only code in examples.** An example is read, so it holds only what it demonstrates. Test vectors, routes that exist for a conformance check, fixtures that force an edge case and anything a harness needs but a reader does not go in a fixture ([`conformance`](../test/fixtures/conformance)) or in the harness, never in an example. If a check needs a route, the route belongs to the fixture.

## Fixtures

Everything else lives in [`test/fixtures`](../test/fixtures), exempt from rule 2 and, for the ones that are not plain Workers code, from rule 1 as well:

| Fixture | What it is for |
| --- | --- |
| [`conformance`](../test/fixtures/conformance) | the binding conformance suite's worker: routes and vectors that exist only for the checks |
| [`stress`](../test/fixtures/stress) | the memory and throughput baseline in [`BASELINE.md`](../test/fixtures/stress/BASELINE.md) |
| [`runtime-comparison`](../test/fixtures/runtime-comparison) | Sproutboat against other runtimes on one corpus |
| [`workers-verbatim`](../test/fixtures/workers-verbatim), [`workers-contract`](../test/fixtures/workers-contract) | Cloudflare's own example source, unedited, and the `(request, env, ctx)` contract |
| [`upload`](../test/fixtures/upload), [`request`](../test/fixtures/request) | a streamed request body, and `new Request(request, init)`: plain Workers code, checked on workerd with the examples, but test material rather than something to read |
| [`lib`](../test/fixtures/lib) | the harnesses, the workerd runner's helpers and the project registry the runners share |

The Cloudflare pattern ports are plain Workers code too, and are checked on workerd and in the native smoke harness like the examples:

| Fixture | Cloudflare example | What the native check covers |
| --- | --- | --- |
| [`cf-json`](../test/fixtures/cf-json) | [Return JSON](https://developers.cloudflare.com/workers/examples/return-json/) | JSON body and content type |
| [`cf-cookies`](../test/fixtures/cf-cookies) | [Cookie parsing](https://developers.cloudflare.com/workers/examples/extract-cookie-value/) | Named cookie and similar-name rejection |
| [`cf-redirects`](../test/fixtures/cf-redirects) | [Bulk redirects](https://developers.cloudflare.com/workers/examples/bulk-redirects/) | Mapped path, Location header, and unmapped path |
| [`cf-headers`](../test/fixtures/cf-headers) | [Set security headers](https://developers.cloudflare.com/workers/examples/security-headers/) | Security headers on a local response |
| [`cf-post`](../test/fixtures/cf-post) | [Read POST](https://developers.cloudflare.com/workers/examples/read-post/) | JSON, text, invalid JSON, and unsupported content type |

The [`workers-verbatim`](../test/fixtures/workers-verbatim) fixtures build the JavaScript from Cloudflare's Return JSON, Cookie parsing, and Redirect examples without handler edits. The native smoke harness checks their responses. The cookie fixture uses the original `cookie` import.

There are intentional differences. Cloudflare's bulk redirect example falls through to an origin fetch for unmapped paths; this port returns 404 because it has no origin. The security headers port sets headers on its own response instead of modifying a fetched origin response. The POST port covers JSON and text, not form data.

The existing [`analytics`](analytics), [`cron`](cron), and [`outbound-fetch`](outbound-fetch) examples already cover the same basic operations as Cloudflare's analytics, Cron Trigger, and fetch examples. HTMLRewriter is outside Sproutboat's current handler surface. [Sign requests](https://developers.cloudflare.com/workers/examples/signing-requests/) needs a separate native test for its Node Buffer import and Unicode signing path.

## Running one

```sh
cd examples/kv
sproutboat dev                      # a real local broker, bindings and all
```

Or as a single file with nothing beside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/kv-example
```

## Checking them

```sh
bun run examples                    # build each example (and the plain-Workers fixtures) as a standalone binary and drive it
bun run examples kv d1              # just these
SMOKE_CONCURRENCY=1 bun run examples  # one at a time (default: 4 at once)
bun run examples:types              # every worker-configuration.d.ts is current, every example typechecks
bun run examples:workerd            # the same smoke requests, on workerd, against Cloudflare's types
```

The website's support table links each binding to the example that
demonstrates it, so this is what stops that table from claiming something no
longer true.
