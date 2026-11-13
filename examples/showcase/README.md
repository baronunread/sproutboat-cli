# showcase

The public showcase page: four things Sproutboat does, happening while you look. The hero and act 01 (Fleet) are built; acts 02 to 04 are specified in [DESIGN.md](DESIGN.md), which also has the visual and motion direction, where every number comes from, what each act needs from the platform, the abuse limits and the spec for whoever builds the rest.

This directory is a fixture, not an example (`examples/lib/public-examples.ts`): it has a front end and its own checks. Its two apps are still standard Workers code and run under workerd.

```
src/                 the page's Worker: /healthz, /api/info, static files
fleet-app/           the app behind every dot in the Fleet act
fleet-contract.ts    the state feed's shape (local supervisor and Cloud endpoint answer in it)
fleet-local.ts       local preview only: 400 slots of real processes, started on a request, stopped when idle
web/                 the page: system/ (tokens, motion, scenes, shared parts), fleet/, sections/
build-web.ts         web/ -> site/ (bundle, Tailwind, code panels cut from the real source)
serve.ts             the page on the LAN: bun serve.ts
check.ts, harness.ts the two apps' contract under sproutboat dev and under workerd
perf-sample.js       frame times and long tasks, to paste into a browser console
```

## Run it

```sh
bun install
bun serve.ts            # prints http://<lan address>:8795; first start builds the fleet binary and the Worker (about a minute)
bun run typecheck       # the Worker, the fleet app, the page, the scripts
bun test
bun run check           # both apps under sproutboat dev
bun run workerd         # the same sources under workerd
```

`PORT` changes the port, `FLEET_APPS` the number of slots, `FLEET_BASE_PORT` where the fleet's processes listen (43100 and up).

## What the local preview is

Real, and not the Cloud. Each dot is a slot for one process of `fleet-app`, built as a standalone binary. A request to a sleeping slot starts the process, the answer is forwarded, and a process nobody has called for 6 s is stopped. Memory is the resident size of the running processes from `ps`. There is no cgroup and no shared runtime, so a process costs about 5 MB here against about 1.3 MiB on Cloud. The page prints "local preview" beside every number that comes from it.

## Deploying

Nothing here deploys, and the Fleet act has no live source on Cloud until the platform work in DESIGN.md section 5 exists (A1 to A3). Deployed without it (`bun run build`, then `sproutboat deploy`), the page shows the dated benchmark and says it is not live. With it, set `FLEET_STATE_URL` and `FLEET_APP_URL` in `sproutboat.jsonc`.
