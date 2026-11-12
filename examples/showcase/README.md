# showcase

A public page that tests four claims about Sproutboat while you watch. One TypeScript Worker (`src/`), a static page (`public/`), a second tiny app that is allowed to sleep (`../showcase-sleeper`), and the checks that hold all of it to what it says. [DESIGN.md](DESIGN.md) has the reasoning and what is still needed from the platform.

```
src/index.ts             the handler: fetch(request, env, ctx), routes, /healthz, caps
src/race.ts              the ticket race: three ways to sell a seat, and the Durable Object
src/timing.ts            per-query microseconds, D1 against the object's SQLite
src/guard.ts             per-address rate limits, caps, client address
public/                  the page (plain HTML, CSS and a module script; theme.css is ikada's tokens)
data/benchmarks.json     the dated 1,000-app benchmark, with its source
data/compare-recorded.json   a recorded workerd run (bun compare.ts), with versions and date
build-web.ts             public/ -> site/ and site-standalone/, plus the code panels (Shiki)
build-binaries.ts        builds, measures and checksums the standalone binaries (bun run binaries)
check.ts                 the contract, run against any running copy of src/
harness.ts               sproutboat dev (or `standalone`) through check.ts
workerd.ts               wrangler dev (workerd) through check.ts
compare.ts               both of those, written to data/compare-recorded.json
serve.ts                 the page and the sleeper on the LAN: bun serve.ts
sproutboat.jsonc         the Cloud config
sproutboat.standalone.jsonc   the same app for `build --standalone` (the binary on the download card)
wrangler.jsonc           the same src/ for workerd
```

## Run it

```sh
bun install                 # shiki, wrangler, workers-types
bun serve.ts                # prints http://<lan address>:8790
bun run check               # sproutboat dev + check.ts
bun run workerd             # the same src/ under workerd, same checks
bun run typecheck && bun test
bun run binaries            # linux-x64, linux-arm64 and this machine; ~10 minutes
```

`bun run build` makes `site/`. Run `bun run binaries` first if you want the download card filled (it calls the build itself).

## CI

The checks run in CI through `ci.patch` (apply it with `git apply examples/showcase/ci.patch`): the existing `runtime-conformance` job gains `bun run showcase` and `bun run showcase:standalone`, and a new `showcase-workerd` job runs `bun run workerd`, the same `src/` through the same checks under workerd. It is a patch because the token that opened the pull request cannot push workflow files; delete it once applied.

## Where every number comes from

| On the page | Source |
| --- | --- |
| Race counts | The rows the run stored, counted by the server when the run ends. |
| µs per query | A batch of at least 10 ms of queries divided by its size (the clock ticks in whole milliseconds). |
| Wake-up time | `performance.now()` in your browser around the request; `cold` is the app saying it served its first request. |
| 1,000 apps, memory per app | `data/benchmarks.json`: dated, sourced, labelled "not live" until `DENSITY_URL` answers. |
| The workerd column | `data/compare-recorded.json`: what `bun compare.ts` got, with date, host, wrangler and workerd versions. Live instead when `COMPARE_URL` is set. |
| File sizes, checksums, start time | `binaries/binaries.json`, written by `build-binaries.ts` from the files themselves. |

## Deploying

Nothing here deploys. For the Cloud: `bun run binaries` (or at least `bun run build`), then `sproutboat deploy` in this folder, and the same in `../showcase-sleeper`. Set the vars in `sproutboat.jsonc`: `SLEEPER_URL` (the sleeper's address), `DENSITY_URL` (`https://<api>/v1/public/density`, once the Cloud serves it), `COMPARE_URL` (this worker deployed on Cloudflare). Empty means the card shows its dated benchmark instead.

Limits: at most 500 fans, 200 seats, 60 separate requests, 8 open sales; 30 runs a minute and 240 purchases a minute per address; one timing run at a time; a sale's rows and object are deleted when it ends and abandoned ones after two minutes. The only row that stays is the single `bench` row.
