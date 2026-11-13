# showcase

The public demo page, planned for **sproutboat.com/demo**: what Sproutboat claims, happening while you look, with a receipt you can check from a terminal. The hero, act 01 (Fleet) and the comparison are built. Acts 02 (Pocket server) and 03 (Self-host in one command) are specified in [DESIGN.md](DESIGN.md), which also has the visual and motion direction, the proof mechanisms, where every number comes from, what the platform has to provide, and the spec for whoever builds the rest. [RESEARCH.md](RESEARCH.md) is the study of other infrastructure demos and the sourced competitor figures behind it.

This directory is a fixture, not an example (`examples/lib/public-examples.ts`): it has a front end and its own checks. Its two apps are still standard Workers code and run under workerd.

```
src/                  the page's Worker: /healthz, /api/info, static files
fleet-app/            the app behind every sprout in the fleet
fleet-contract.ts     the feed's shape (local supervisor and Cloud endpoint answer in it)
fleet-local.ts        local preview only: 1,000 slots of real processes, started on a request, stopped when idle
data/comparison.json  every competitor figure, with its kind, source and date (a test checks each cell)
web/                  the page: system/ (tokens, motion, the app mark, shared parts), fleet/, sections/
build-web.ts          web/ -> site/ (bundle, Tailwind, code panels cut from the real source)
serve.ts              the page on the LAN: bun serve.ts
check.ts, harness.ts  the two apps' contract under sproutboat dev and under workerd
perf-sample.js        frame times and long tasks, to paste into a browser console
```

## Run it

```sh
bun install
bun serve.ts            # prints http://<lan address>:8795/demo/; first start builds the fleet binary and the Worker (about a minute)
bun run typecheck       # the Worker, the fleet app, the page, the scripts
bun test
bun run check           # both apps under sproutboat dev
bun run workerd         # the same sources under workerd
```

`PORT` changes the port, `FLEET_APPS` the number of slots, `FLEET_BASE_PORT` where the fleet's processes listen (43100 and up). The page is served at `/` and at `/demo/`; it asks only for relative URLs so that both work.

## Check that it is real

With the preview running, from any machine on the network:

```sh
curl -si http://<lan address>:8795/fleet/app/235     # cold: true, a pid, a request id; its dot lights on the page
curl -si http://<lan address>:8795/fleet/app/235     # served: 2, the same pid
curl -s  http://<lan address>:8795/fleet/state/235   # what the host says about that process
curl -s  http://<lan address>:8795/fleet/state       # the feed the page polls; your request ids are in "recent"
```

Wait six seconds and the first line says `cold: true` again, with a new pid.

## What the local preview is

Real, and not the Cloud. Each mark is a slot for one process of `fleet-app`, built as a standalone binary. A request to a sleeping slot starts the process, the answer is forwarded with the receipt headers, and a process nobody has called for 6 s is stopped. Memory is the resident size of the running processes from `ps`. There is no cgroup and no shared runtime, so a process costs about 5 MiB here against about 1.3 MiB on sproutd. The page prints "local preview" beside every number that comes from it.

## Deploying

Nothing here deploys, and the Fleet has no live source on Cloud until the platform work in DESIGN.md section 7 exists (F1 to F3, F6, F7). Deployed without it (`bun run build`, then `sproutboat deploy`), the page shows the dated benchmark and says it is not live. With it, set `FLEET_STATE_URL` and `FLEET_APP_URL` in `sproutboat.jsonc`.
