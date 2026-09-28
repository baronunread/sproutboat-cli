# Cloudflare Worker source compatibility

These handler files contain the JavaScript from Cloudflare's published examples without Sproutboat-specific edits. Each directory adds only a `sproutboat.jsonc` build configuration. `cookie@2.0.1` is installed for the cookie example's original import.

| Fixture | Cloudflare source | What the native smoke test checks |
| --- | --- | --- |
| `return-json` | [Return JSON](https://developers.cloudflare.com/workers/examples/return-json/) | JSON body and content type |
| `cookie-parsing` | [Cookie parsing](https://developers.cloudflare.com/workers/examples/extract-cookie-value/) | Present and missing cookies |
| `redirect` | [Redirect all requests](https://developers.cloudflare.com/workers/examples/redirect/) | 301 and Location header |

Run `bun examples/smoke.ts worker-return-json worker-cookie-parsing worker-redirect` from the CLI repository with the updated local runtime linked. The suite builds and drives native standalone binaries, not Bun's JavaScript runtime. The fixtures use compatibility date `2026-09-28`, when the Workers `(request, env, ctx)` handler arguments become available. Until that runtime version is published and the CLI dependency is updated, these fixtures are omitted from the default `bun run examples` command.

These three examples have no origin dependency. Cloudflare's bulk redirects and security headers examples call `fetch(request)` to reach an origin. Sproutboat needs an explicit origin mapping before those examples can have equivalent fallback behavior. Do not list them as unchanged compatible examples yet.
