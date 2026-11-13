# Showcase v2: design

A public page at **sproutboat.com/demo** where what Sproutboat claims is happening while you look, in a form a sceptical developer can check from their own terminal.

This is the second revision of v2. The first drew an app two different ways (a light over water in the hero, a dot in a grid below), compared itself to nobody and gave a visitor no way to tell it from an animation. The research behind the changes is in [RESEARCH.md](RESEARCH.md).

**Built:** the design system, the hero and act 01 (Fleet) on one shared stage, the proof mechanisms in their local-preview form, the cold-start scale, and the comparison (04).
**Specified here for the next builder:** act 02 (Pocket server) and act 03 (Self-host in one command).
**Later, placeholders only:** a compatibility check, and deploying your own app into the fleet.
**Dropped from launch:** Crash arena and Sleeping crowd. Sleeping crowd's one number (memory per idle WebSocket) lives in the comparison.

## 1. Direction: "Waterline"

The logo is two leaves cut by a waterline. The page takes that literally: **an app is a seed on its own waterline. Asleep, that is all there is. Running, it sprouts: a stem lifts a light off the line.**

- **One mark for an app.** `web/system/sprout.ts` is the only code that draws one. Every scene calls it. Section 3 is the rule.
- **Dark, and darker than the dashboards.** The ground is `ink` (`oklch(0.13 0.012 255)`); sections alternate `ink` and `deep`. No cards, no panels, no borders around content.
- **Green means one thing.** `alive` (#5BD97A) is a process that is running right now. It is never decoration, a heading, a hover, or a bar in a chart. A test fails if another token takes that hue. Refusals are amber; nothing is red. Charts and comparison marks are neutral (`line` for ours, `asleep` for others).
- **Type.** Figtree for words at display sizes (44 to 88 px). JetBrains Mono, tabular, for every number, label and line that reports a measurement, so prose and data are told apart by the face alone.
- **One column, two lines.** Content sits between the same two edges (`.wrap`). Stages bleed past them; words never do.
- **The code is one button away, and it is the real code**, cut from the running files at build time.
- **Every number says whose it is.** Measured now, measured by us on a date, or published by someone else with a link. Section 6.

Components come from `@sproutboat/ikada` (Button, Dialog, Tabs) on Base UI, styled by Tailwind v4 with ikada's theme. The showcase adds nine `--stage-*` colours, five type sizes and the motion constants, in `web/system/tokens.ts`.

## 2. Motion language

**Motion is evidence.** Something moves because something happened: a process started, a request was answered, a measured number changed, or the visitor's pointer is there. Otherwise the page is still. Four verbs; an act may not invent a fifth without adding it here.

| Verb | Means | How it moves | Where it lives |
| --- | --- | --- | --- |
| **wake** | a process started | the light rises on its stem on a spring that overshoots once (stiffness 320, damping 17, about 350 ms) | `stepEnergy`, `drawSprout` |
| **settle** | a process was stopped for being idle | a plain exponential fall back to the line, about 700 ms. Slower than wake on purpose | `stepEnergy` |
| **ripple** | one request was answered | one ring spreading on the water, 760 ms. One per request, never without one | `drawRipple` |
| **level** | a measured number changed | eases to the new sample in 420 ms and never passes it. Data does not bounce | `LiveNumber`, the cold-start mark |

Not data, and drawn so it cannot be mistaken for it: **brackets**. Four neutral corner marks around the app under the pointer (faint) and around the app in the inspector (bright). A request in flight to a sleeping app is a neutral ring closing in on its seed.

Removed in this revision: the hero's swell (the only ambient motion; with a flat grid it read as noise) and the perspective field.

One staged entrance exists: the hero's words, once, on load (70 ms apart, 820 ms each, 16 px rise with a 6 px blur). Nothing enters on scroll.

**Performance rules.** Canvas for anything with more than a few dozen moving things; DOM animation only on `transform`, `opacity`, `filter` and one `inset-inline-start` on a 6 px mark. A scene's loop runs only while its canvas is on screen and something is still moving. Pixel ratio capped at 2. Glows are one pre-rendered sprite, stamped. React renders an act once; live text is written straight to its DOM node.

**Reduced motion and pause.** `motionOff()` is true under `prefers-reduced-motion` or the nav's pause button. Scenes then draw states without transitions (a sprout is up or it is not; a ripple is a ring that fades in place), numbers jump, the chip's dot does not beat, the entrance is a 200 ms fade. Nothing is hidden.

Measured 2026-11-13, headless Chrome on the dev Mac, `perf-sample.js`, 1,000 apps: hero idle, a wave of 48, a 60-step sweep and a wave in the Fleet position, 3 s each, at 1440 px and at 390 px with 4x CPU throttling. Every run: 16.67 ms average, 16.9 ms worst frame, none over 20 ms, no long tasks. This is not a phone; repeat it on one before launch.

## 3. One visual language

The rule: **an app is drawn by `sprout.ts`, at any size, and by nothing else.**

```
  asleep        running
                  o        the light (head)
                  |        the stem
  ─ · ─         ─ · ─      the app's own waterline, the seed on it; a running app throws a reflection onto it
```

- Every size is a fraction of `cell`, the room one app has: 12 px in the fleet on a phone, 20 px on a desktop, 200 px where an act shows a single app (act 02's "the copy you are running").
- In DOM text, the same mark is `SproutGlyph` (the legend uses it).
- **One fleet, one arrangement, one canvas.** The hero and act 01 are a single section. The grid sits in a sticky column and stays put while the words beside it change from the opening claim to the act. App 281 in the hero is app 281 in the Fleet act because it is the same pixels. On a phone the order is hero words, the grid, the inspector, then the Fleet words.
- **The legend says what a mark is:** `asleep · running · 1 dot = 1 app = 1 process = 1 URL`.
- Outside the fleet, an app that appears (the downloaded copy in act 02, the app deployed at the end of act 03's recording) is the same sprout, large.

## 4. Storyboard

### Launch

#### Hero and 01 Fleet (built)

Left, the claim: "A thousand apps on one small server." Right, the fleet: a thousand seeds in a grid, and under it the inspector.

About a second after the first live sample the page sends one ordinary request to one randomly chosen app. Its seed sprouts, a ring spreads, and the inspector opens on it: its number, what the host says about its process (`running · pid 48213 · since 09:01:11 · 5.4 MiB`), the `curl` line that calls it, and the answer the page got, printed like `curl -si` prints it, with the platform's headers. Bottom left: "Your visit started app 281 in 7.6 ms. It stops again after 6 s of silence." The first thing the page does is the product, performed on the visitor's request, with the receipt beside it.

Scrolling changes the words, not the stage. Act 01, "Asleep until someone asks":

- **Sweep.** Moving the pointer or a finger across the grid sends each app it crosses a request.
- **Wave.** "Send a wave of 48 requests" lights a disc from the centre outward.
- **Pick.** A click, a tap or the "App" number field chooses the app in the inspector. "Send it a request" does that for keyboard users.
- **Readouts.** Running `48 of 1,000`, Memory, Last start, a one-minute memory trace.
- **Tail.** The fleet's last five requests as the platform reports them, from anyone: time, app, cold or warm, the request id. Rows this page sent are marked `you`. A request from the visitor's own terminal shows up here with the id their terminal printed.
- **E. Cold start, on one scale.** A logarithmic scale from 1 ms to 4 s. The top row is this visit: the server's start time and the round trip in the visitor's browser, moving as they wake apps. Under it, published figures for Cloudflare Workers, AWS Lambda, Fly Machines and Vercel, each linking to its source, and our own measurement of a bare Node.js process, marked "ours". A mark is drawn only where the source gives a number.
- Then silence: after the idle time the sprouts fall back in the order they woke and the memory number walks down.

#### 02 Pocket server (to build)

"This page is one file. Take it."

- **Download.** Three buttons (Linux x86-64, Linux arm64, macOS arm64) with real sizes and SHA-256 sums from `binaries.json`, written by `build-binaries.ts` (reuse v1's, branch `feat/showcase`). macOS binaries are not notarised at launch: next to that button, in body-size text, the line `xattr -d com.apple.quarantine ./sproutboat-demo` with a copy button and one sentence saying why. Notarisation comes later.
- **D. Binary X-ray.** Two bars on one linear scale of bytes. Top: the binary, split into what is in it (the runtime, TLS, the compiled app, the page's static files). Bottom: a container image of the same app on Node.js, split by layer (base OS, Node, `node_modules`, the app). The binary is a sliver of the image, and the scale is not broken to flatter either. Under the bars, three measured pairs: size on disk, time from start to first answer, resident memory idle. Hovering or focusing a segment names it and gives its bytes. Every number comes from `data/xray.json`, written by a script (see section 8); nothing is typed in by hand.
- **Proof 4: run a dot yourself.** A three-line snippet: start the binary, `curl` it, `ps -o rss= -p <pid>`. The page states what they should see and on what we measured it.
- **I. Works offline.** When the page is served by a downloaded copy (`api/info` says `edition: "standalone"`), the act turns around: "You are running a copy." A chip in the nav reads `Served by the copy on your machine · no network needed`. The fleet stage shows one large sprout, this process, with its own inspector (`api/self`: pid, start time, memory, requests served). Fonts, script, styles, the comparison and the X-ray are all in the binary; the page makes no request to another origin on load, and a test holds it to that. Links to sources are marked as needing a network.

The country map from the first draft is gone: it needed a check-in, and "no network" is the stronger statement.

#### 03 Self-host in one command (to build; needs a real recording)

"The whole platform, on a server you rent for a few dollars."

A terminal, playing an **unedited recording** of one real session: a fresh VPS, `curl -fsSL https://sproutboat.com/install.sh | sudo bash`, the installer's questions, the DNS pause, the three things it prints, then on the laptop `sproutboat login`, `sproutboat deploy`, and a `curl` to the new app.

- Chapter marks along the top with their true durations ("Install 2 m 41 s", "Deploy 9 s", "First answer 12 ms"). They are markers in the recording, not text typed onto the page.
- It plays in real time by default. A speed control offers 4x and "skip waits"; whichever is on is shown in the chapter bar, and the total real time stays visible.
- A caption states the machine (provider, plan, price, vCPU, memory), the OS image, the Sproutboat version, the date, and links the raw `.cast` file with its SHA-256.
- When the recording reaches the first answer from the deployed app, a large sprout beside the terminal lights (wake) and stays. The chip reads `Recorded`, never `Live`.

How to record it honestly is in section 8. It needs a real VPS run, which the main thread arranges.

#### 04 Compared (built)

"The same thousand apps, somewhere else." One figure and three tables.

- **The figure:** memory of 1,000 idle apps on one server. Sproutboat 1.25 GiB, Node.js processes 47.4 GiB, and a dashed line at 2 GiB: the host this page's fleet runs on. One bar ends before the line. Both figures are ours and say on what they were measured.
- **On a server you run:** Sproutboat, Node.js, OpenOrange self-hosted. Memory per idle app, cold start, what runs.
- **On someone else's servers:** Sproutboat Cloud, Cloudflare Workers, AWS Lambda, Fly Machines, Vercel Fluid, Deno Deploy. Memory an app gets, cold start, price while idle, where it runs.
- **Holding a connection for someone who says nothing:** Sproutboat 5 to 9 KiB per idle WebSocket, OpenOrange about 1 MB (our measurement of theirs), Cloudflare not published.
- Every table ends in a column nobody else's comparison has: **what the other platform gives that we do not.** Our own rows say what we do not give yet (one region, a subset of JavaScript, 32 MiB, no published Cloud price).

Why its own section and also woven in: a comparison belongs where the claim is made (the cold-start scale sits in Fleet, the X-ray in Pocket), and the full table with its caveats needs room and one address (`#compared`) the woven pieces can link to.

### Later (placeholders on the page, not built)

- **A. "Is my Cloudflare project compatible?"** After plan 015 (`wrangler.jsonc` as native config) and `sproutboat doctor`. Paste or drop a `wrangler.jsonc`; get an answer binding by binding. It runs in the browser on the file's text and sends nothing.
- **B. Deploy your own app into the fleet.** After plan 014 (build speed). One command, and a new sprout appears in the grid with the visitor's app behind it. This is the strongest proof of all and the most platform work: see open question 5.

### Dropped from launch

Crash arena and Sleeping crowd, with their motion verb (`cut`) and their platform work (a public event stream, hibernated-socket counts).

## 5. Proof it is real

Four mechanisms, chosen because each can be checked without trusting the page. All of them expose one allow-listed account, the showcase fleet. No tenant's data, no visitor's address, path or user agent appears anywhere.

| # | Mechanism | What the visitor does | In the local preview | Platform support | Effort |
| --- | --- | --- | --- | --- | --- |
| P1 | **Every dot is a URL, and the answer carries a receipt** | Copies `curl -si https://app-235.<fleet host>/`, runs it twice, waits, runs it again. Sees `cold: true`, then `served: 2`, then a new pid and `cold: true` | built: `/fleet/app/235`, headers added by `fleet-local.ts` | **Cloud/ops:** 1,000 copies of `fleet-app` under one showcase account on the dedicated 2 GB host (F1, F2). **sproutd:** `Server-Timing: wake;dur=` on the answer that started a worker and `x-sproutboat-request-id` on every answer (F3); `x-sproutboat-pid` and `x-sproutboat-started` for accounts with a setting that allows it (F4). **Edge:** pass those headers through, and a per-address rate limit on the fleet's hostnames (F5) | S + M + S + S + S |
| P2 | **The raw feed, and the host's facts about one process** | Opens "Raw feed": the JSON the page polls. Opens `<feed>/235`: pid, start time, memory. Compares the pid with the header from P1 | built: `/fleet/state`, `/fleet/state/235` | **sproutd:** report memory for a set of apps, and per app on request (F6). **Cloud:** `GET /v1/public/showcase/fleet` and `/fleet/<i>`, one allow-listed account, cached 1 s, CORS open; extends Cloud PR #60 (F7) | M + M |
| P3 | **A public tail with request ids** | Runs the `curl` line and watches its own request id appear in the tail on the page, and the dot light, for everyone looking | built: `recent` in the feed | **sproutd:** the request id in `tail` events (with F3). **Cloud:** the last 12 requests of the showcase account in the feed, as `{id, i, at, cold, wakeMs}` and nothing else (F8) | S on top of P1 and P2 |
| P4 | **Run one yourself** | Downloads the binary in act 02, starts it, measures it with `ps` | n/a | none. Release artefacts with checksums (R1) | S, in act 02 |

Also, at no platform cost: the page's source and the fleet app's source are linked, the code panels are cut from the running files, and the footer should carry the commit the page was built from (the build already writes a source hash).

Considered and not chosen for launch: **deploying your own app into the grid.** It is the best proof and it needs sign-up without an invite, an abuse story for arbitrary code on the showcase host, and fast builds. It is "Later B".

**Where the mechanisms sit:** the inspector under the grid (P1, P2), the tail in act 01 (P3), the "Raw feed" link beside the tail, act 02 (P4). The hero shows the inspector on first paint, so the answer to "is this fake?" is on the first screen.

## 6. Data: what is live, what is labelled

Rule: **a number is measured now, or it carries its source and date beside it.** The `LiveChip` says which, and changes to "Stale" if samples stop.

| Where | Shown | Source | Kind |
| --- | --- | --- | --- |
| Hero, Fleet | which apps are running, how many, memory | the feed (`FleetSnapshot`, `fleet-contract.ts`) | live |
| | start time | `Server-Timing: wake` on the answer | live, per request |
| | round trip | `performance.now()` around `fetch` in the visitor's browser. It includes their network, and the label says "in your browser" | live |
| | pid, start time, memory of one app | `<feed>/<i>` (`FleetAppFacts`) | live |
| | tail | `recent` in the feed | live |
| | other platforms' cold starts | `data/comparison.json`, `coldStart` | published, linked, read on a date |
| | "1,000 apps idle in 1,282 MiB" | `data/benchmarks.json` | recorded; shown when there is no live feed |
| Pocket | sizes, checksums | `binaries.json` from `build-binaries.ts` | measured at build |
| | X-ray | `data/xray.json` from `build-xray.ts` | measured at build, with the image digest and date |
| | this copy's pid, memory | the binary's own `api/self` | live, standalone only |
| Self-host | every timing | markers in the `.cast` file | recorded, with date and machine |
| Compared | everything | `data/comparison.json` | published, measured by us, or "not published" |

`data/comparison.json` gives every cell a `kind`. `showcase.test.ts` fails when a cell has none, when a `published` cell has no `https` URL, when a `measured` cell does not say when or on what, or when a platform row does not say what it gives that we do not. `readOn` is printed on the page; re-read the sources and bump it before launch and at each release.

**Local preview.** A laptop has no sproutd, so `serve.ts` runs `fleet-local.ts`: 1,000 slots, each a copy of `fleet-app` built as a standalone binary. A request to a slot starts a real process (5 to 15 ms on the dev Mac), an idle one is stopped after 6 s, memory comes from `ps`, and the receipt headers are added by the supervisor. Nothing is simulated. It is also not sproutd (no cgroup, no shared runtime, about 5 MiB resident per process against about 1.3 MiB), and the chip says so beside every number.

**No feed** (Cloud before the platform work lands): `api/info` returns `fleet: null`, the grid draws dim, the controls are disabled and the chip reads `RECORDED · 1,000 apps idle in 1,282 MiB on one host. Benchmark a22-density, 2026-11-05; not live here.`

## 7. Platform work

What exists today (read from `sproutd` and `sproutboat-cloud` on 2026-11-13): sproutd's admin `list` returns every app's state and `tail` streams per-request events, both behind operator or owner scope. Nothing reports memory. No response carries `Server-Timing`, a request id or any `x-sproutboat-*` header. Nothing is public; Cloud PR #60 drafts `GET /v1/public/density`. `reap-ms` is one setting for the whole daemon. Path-scoped routes on the main site exist (`/docs`, `/ikada`).

Effort: S up to half a day, M one to two days, L three or more.

| # | For | Work | Where | Effort | Without it |
| --- | --- | --- | --- | --- | --- |
| F1 | P1 | The dedicated 2 GB showcase host, in the fleet's own account, with nothing else on it | ops (main thread) | M | no fleet on Cloud |
| F2 | P1 | A script that writes 1,000 configs and deploys `fleet-app` as `app-000` to `app-999`; a wildcard certificate for the account (exists per account) | showcase script + main thread to run it | S | no fleet |
| F3 | P1, P3, E | `Server-Timing: wake;dur=` on the answer that started a worker; `x-sproutboat-request-id` on every answer and in `tail` events | sproutd | S | the page shows the browser's round trip only; the tail cannot mark "you" |
| F4 | P1, P2 | `x-sproutboat-pid` and `x-sproutboat-started`, only for apps whose account opts in | sproutd | S | the inspector shows pid from the feed only; the cross-check is lost |
| F5 | abuse | Per-address rate limit for the fleet's hostnames (about 40 requests a second); pass the receipt headers through | edge | S | abuse relies on the host being isolated |
| F6 | P2 | Memory reporting: the sum of private memory over a set of apps' workers, and one app's on request, sampled at most once a second | sproutd + adapter | M | no memory number on Cloud |
| F7 | P2 | `GET /v1/public/showcase/fleet` (a `FleetSnapshot`) and `/fleet/<i>` (`FleetAppFacts`) for one allow-listed account; cached 1 s; CORS open. Extends PR #60 | cloud | M | the grid cannot show sleep on Cloud |
| F8 | P3 | `recent`: the last 12 requests of that account in the snapshot | cloud + adapter | S | no tail |
| F9 | Fleet | An idle time of about 8 s for the showcase account (`reap-ms` per account) | sproutd | S to M | sprouts stay up for the daemon's default; slower to watch, still true |
| F10 | page | Mount the page at `sproutboat.com/demo`: a path route to the showcase app, with its static files served under that prefix. The page already asks only for relative URLs and the Worker accepts the prefix | cloud routes + site | S | serve it on its own hostname |
| R1 | P4, act 02 | Release binaries for three targets with checksums, at a stable URL | release pipeline | S | no download |
| R2 | act 02 | Notarised macOS binaries | release pipeline | M | the page shows the `xattr` line (the launch plan) |
| V1 | act 03 | A fresh VPS, a domain with DNS access, one supervised recording session | main thread | S | no act 03 |
| L1 | Later A | `sproutboat doctor` and its rules as a library the page can run in the browser | cli (plan 015) | M | no compatibility check |
| L2 | Later B | Sign-up without an invite, a guest tier on the showcase host, fast builds | cloud (plan 014) | L | no deploy-your-own |

F3, F6 and F7 are the core: with them the Fleet is live on Cloud with its receipt. F1 and F2 are operations. Act 02 needs only R1. Act 03 needs only V1.

## 8. Spec for the builder

Read `web/sections/fleet.tsx` and `web/fleet/` first: the Fleet is the reference.

### File layout

```
src/index.ts            the page's Worker: /healthz, /api/info, static files. Add each act's routes here.
fleet-app/              the app behind every sprout
fleet-contract.ts       the feed's shape: FleetSnapshot, FleetRequest, FleetAppFacts
fleet-local.ts          local preview only: real processes, the receipt headers, the tail
serve.ts                the LAN preview, at / and at /demo/
build-web.ts            web/ -> site/ : bundle, Tailwind, code panels, build info
regions.ts              PANELS: which real files and regions each "How it works" shows
data/comparison.json    every competitor figure, with kind, source and date
data/benchmarks.json    our recorded benchmark
web/system/             sprout.ts (the app mark), scene.ts, motion.ts, tokens.ts, feed.ts, live.tsx, act.tsx, chrome.tsx
web/fleet/              store.ts, grid-scene.ts, dots.ts, inspector.tsx, cold-ladder.tsx
web/sections/           fleet.tsx (hero + act 01), upcoming.tsx, compared.tsx
```

A new act adds `web/<act>/`, `web/sections/<act>.tsx`, a `PANELS` entry, its routes in `src/index.ts`, its checks in `check.ts`, its rows in sections 6 and 7 here, and removes its row from `upcoming.tsx`.

### An act's anatomy

```tsx
<section id="pocket" className="act overflow-clip border-t border-stage-line/8 bg-stage-deep">
  <div className="wrap grid min-h-svh ... lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]">
    <div>  <Eyebrow number="02">Pocket server</Eyebrow>, h2.text-title, p.text-lede, buttons, <HowItWorks>  </div>
    <div>  the stage  </div>
    <div>  readouts, one mono line (aria-live), <LiveChip>  </div>
  </div>
</section>
```

Grounds: hero and Fleet `ink`, Pocket `deep`, Self-host `ink`, Compared `deep`. On a phone the order is words, stage, readouts. A grid that holds a `pre` or `code` needs `grid-cols-[minmax(0,1fr)]` on a phone or it will widen the page. Copy: about 70 words an act outside the readouts; headings name the thing; buttons say what they send.

### 02 Pocket server

1. `build-binaries.ts` and `sproutboat.standalone.jsonc` from v1. Output `binaries/binaries.json`: target, bytes, sha256, build date, toolchain version.
2. `build-xray.ts` writes `data/xray.json`. It must measure, on Linux x86-64:
   - the binary: total bytes, and its parts from the linker map or `llvm-size -A`, grouped as runtime, TLS, compiled app, embedded static files, other. The groups must sum to the file size; "other" takes the remainder and is shown;
   - the image: a committed `xray/Dockerfile` that runs the same `fetch` handler on `node:<current LTS>-slim` behind a small `node:http` adapter, plus the same `site/`. `docker build`, then `docker image inspect` for the size and `docker history --no-trunc` for the layers. Record the base image digest and Docker's version;
   - for both: time from start to first answer (20 runs, median and worst) and resident memory idle after 5 s (`/proc/<pid>/smaps_rollup`; for the container, the cgroup's `memory.current`).
   The page prints the date, the machine and the base image. If the script cannot run Docker it fails; it never falls back to old numbers.
3. The X-ray scene: two horizontal bars on one linear byte scale, drawn in DOM (a dozen segments, no canvas needed). Neutral fills at different lightness; no green. Segments are focusable and name themselves. On a phone the bars stack and keep the shared scale.
4. `api/self` in the standalone edition: `{ pid, startedAt, memoryKiB, served }`. The fleet store gets a second source: when `edition` is `standalone`, one app, state from `api/self`.
5. A test that the built `site/` references no other origin in `index.html`, the CSS or the script's load path.
6. The `xattr` line beside the macOS button, with copy. Remove it when R2 lands.

### 03 Self-host in one command: how to record it

Nothing here may be staged. The main thread arranges the machine and runs the session; the builder builds the player and receives the file.

1. **Machine.** A fresh VPS from a mainstream provider on its smallest x86-64 plan that meets the requirements (Debian or Ubuntu, systemd, cgroups v2). Note the plan, price and region for the caption. Nothing installed beforehand.
2. **Domain.** A throwaway subdomain with DNS access. The installer pauses for a wildcard `A` record. Create the record during the pause, on camera, in a second pane or by a one-line API call typed in the session. The wait is part of the truth; the player's "skip waits" handles the boredom.
3. **Recording.** `asciinema rec` (cast v2) from the laptop, one continuous session: `ssh` to the VPS, the install command, exit, `sproutboat login`, `sproutboat deploy` of `examples/hello`, `curl -si` of the deployed app. No `--idle-time-limit`. Add markers live, with asciinema's marker key binding, never afterwards, at: install starts, DNS pause starts, install ends, deploy starts, deploy ends, first answer.
4. **Secrets.** The installer prints an admin token. Destroy the VPS and the DNS record straight after the session so the token and the hostname are dead, and say so in the caption. Do not edit the file to hide it. Use a role address for the Let's Encrypt email.
5. **If it goes badly** (a failure, a slow mirror), record again from a new machine. Never splice two sessions. Publish the one that is shown, whole.
6. **Player.** `asciinema-player` (Apache 2.0), loaded when the act comes on screen, themed with the stage tokens, bundled so it works offline. Chapter bar from the markers with real durations. Default speed 1x; 4x and "skip waits" as labelled options.
7. **A test** that the `.cast` timestamps only increase, that the six markers exist, and that the caption's durations equal the marker differences.
8. **The sprout.** At the "first answer" marker a large sprout beside the terminal wakes, driven by the player's time.

### Rules that are checked or will be asked about

1. Nothing animates unless an event or the pointer caused it. No entrance on scroll.
2. Every number has a `LiveChip` or a source and date in the same act.
3. Green is a running process. Charts are neutral.
4. An app is drawn by `sprout.ts` (canvas) or `SproutGlyph` (DOM). No third way.
5. Canvas scenes extend `Scene`, allocate nothing per frame, and return `false` from `draw` when nothing is moving.
6. `motionOff()` is respected in every scene and every DOM animation.
7. Works at 390 px with no sideways scroll; stages use `touch-action: pan-y`.
8. The page asks only for relative URLs, so it works under `/demo/` and from a binary at `/`.
9. App code is standard Workers TypeScript and runs under workerd through `bun run workerd`.
10. Before handing back: screenshots at 390 and 1440 including hover, focus and reduced motion, a motion capture, `perf-sample.js` at both sizes with 4x throttling at 390, `bun run typecheck`, `bun test`, `bun run check`, `bun run workerd`, lint and format clean.

## 9. Abuse limits

| Surface | Limit | Enforced by |
| --- | --- | --- |
| Fleet, local | 1,000 slots; at most 120 processes alive; idle stop at 6 s; per address 160 requests then 40 a second; a start over 3 s is killed | `fleet-local.ts` (`FLEET_LIMITS`), tested |
| Fleet, page | its own budget of 70 then 30 a second, under the server's, so a fast sweep skips apps instead of being refused; a running app is re-asked at most once in 0.9 s; process facts at most once a second, and not while the app is known to be asleep | `web/fleet/store.ts` |
| Fleet, Cloud | a host of its own, so a wake storm cannot touch a tenant; 1,000 apps awake at about 1.3 MiB fit in 2 GB with room; a 32 MiB cgroup per app; F5's rate limit; the feed is one cached read a second whoever asks | sproutd, edge, F7 |
| Feed and tail | one allow-listed account; no addresses, paths, headers or user agents; 12 rows | cloud (F7, F8) |
| Pocket | downloads are static files; `api/self` exists only in the standalone edition and reports only the copy's own process | showcase Worker |
| Self-host | a recording; the machine in it no longer exists | n/a |

## 10. Open questions

Each has a recommendation.

1. **Do the November figures say what the page says?** "1.28 MiB per idle app" (sproutd #102), "5 to 9 KiB per socket against about 1 MB" (#110) and "wake 4 to 60 ms" (#111) are on unmerged branches I could not read. Recommended: the sproutd owner checks the four sentences in `data/comparison.json` against each benchmark's README before launch, and the benchmarks are merged so the page can link a commit.
2. **Which headers may sproutd add for everyone?** Recommended: `Server-Timing: wake` and `x-sproutboat-request-id` on every app (both are useful to any customer and reveal nothing); pid and start time only for accounts that opt in, which at launch is the showcase account alone.
3. **Is a public, allow-listed feed acceptable (F7, F8)?** It exposes one account's app states, one memory total, per-app process facts and its last 12 requests. Recommended: yes, as an extension of Cloud PR #60, limited by configuration to the showcase account.
4. **The Node.js baseline was measured on macOS, once.** Recommended: re-measure on the Linux box that measures the X-ray, 20 runs, and replace the three "ours" figures (48.5 MiB, 31 to 38 ms, 47.4 GiB) before launch. `build-xray.ts` can write them.
5. **Which base image is the fair one for the X-ray?** Recommended: `node:<LTS>-slim` as the main bar and `node:<LTS>-alpine` as a second, thinner comparison, both shown. Picking only the larger would be the kind of comparison this page says it does not make.
6. **Should Sproutboat Cloud's row have a price?** It says "Not announced". Recommended: leave it until pricing is public; do not put an estimate on a comparison page.
7. **The self-host recording: interactive or with `SB_*` variables?** Recommended: interactive. Three typed answers are easier to follow than a line of environment variables, and it is what a first-time user will do.
8. **Idle time for the showcase account (F9)?** Recommended: 8 s. With the daemon's default the act is still true, only slower to watch.
9. **Page weight.** The script is about 127 KB gzipped before `asciinema-player`. Recommended: keep React and ikada; load the player only when act 03 is on screen.
10. **Deploy-your-own (Later B): a guest tier, or accounts?** Recommended: decide after plan 014. A guest deploy into a fenced row of the grid, expiring in an hour, is the version that needs no sign-up, and it is the one that makes the demo undeniable.
