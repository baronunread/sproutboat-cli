# dogfood

Internal apps. They are not examples: nothing here is written to be read first or copied.

| App | What it is |
| --- | --- |
| [`kitchen-sink`](kitchen-sink) | every binding in one Worker, with a dashboard and a chat room; the suite both backends (broker and standalone) are held to |
| [`quote-service`](quote-service) | a `WorkerEntrypoint` with an RPC method, the peer `kitchen-sink` reaches through a service binding |

Both are deployed on Sproutboat Cloud, under the names in their `sproutboat.jsonc` (`kitchen-sink`, `quote-service`), and every generation swap is checked against them. The Cloud runbooks refer to them by that deployed name, not by a path here, so the names do not change when a directory does; `src/examples-rules.test.ts` fails if one does.

Three other places use them:

- `bun run kitchen-sink` and `bun run kitchen-sink:standalone` run the kitchen-sink checks on the broker and on a standalone binary. The downstream job of [sproutboat-packages](https://github.com/baronunread/sproutboat-packages) runs these two scripts against every packages PR, so their names are fixed.
- `bun run examples:workerd` runs both apps on workerd with the examples, which keeps them standard Cloudflare Workers.
- `src/kitchen-sink-cloud.test.ts` keeps `kitchen-sink` buildable on a Cloud generation.

`kitchen-sink` is JavaScript on purpose: its dashboard excerpts its own source between `#region` markers, and its harness compiles it unbundled. It is the one named exception to "the entry is TypeScript" (`NOT_TYPESCRIPT` in `src/examples-rules.test.ts`).

For something to learn from, read [`examples/`](../examples). For something to start a project from, run `sproutboat init --template`.
