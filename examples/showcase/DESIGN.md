# Showcase v2: design

A public page where four things Sproutboat does are happening while you look at them. Version 1 (PR #184) was rejected: it looked like a dashboard, it did not move, and its sections echoed another product's demo. This version keeps v1's plumbing (the Worker, the code panels cut from real source, the workerd run, the build scripts) and replaces the concept, the look and the page's whole front end.

Built so far: the design system, the page shell, the hero and act 01 (Fleet). Acts 02 to 04 are specified here for the next builder.

## 1. Direction: "Waterline"

The logo is two leaves cut by a waterline. The page takes that literally: **an app is either below the line (asleep, unlit) or above it (running, lit).** Everything on the page is a way of watching apps cross that line.

- **Dark, and darker than the dashboards.** The ground is `ink` (`oklch(0.13 0.012 255)`), under ikada's dark canvas, so that light reads as light. Sections alternate `ink` and `deep`. No cards, no panels, no borders around content: an act is a full screen with a stage behind the words.
- **Green means one thing.** `alive` (#5BD97A) is a process that is running right now. It is never decoration, never a heading, never a hover. The only other green is ikada's primary button. A test (`showcase.test.ts`) fails if another token takes that hue. Refusals (a cap, a rate limit) are amber; nothing on the page is red.
- **Type.** Figtree for words, at display sizes the dashboards never use (`text-display` 44 to 88 px, `text-title` 32 to 52 px, tight tracking, weight 600). JetBrains Mono, tabular, for every number, label and line that reports a measurement, so a reader can tell prose from data by the face alone.
- **One column, two lines.** Every act's content sits between the same two edges (`.wrap`, gutter `clamp(1.25rem, 4.2vw, 4rem)`). Stages bleed past them; words never do.
- **One act per screen.** The hero is alone on the first screen; each act is `100svh` on desktop and may run to two screens on a phone.
- **The code is one button away, and it is the real code.** Each act has a ghost button, "How it works", that opens the source the act runs, cut from the files at build time.

Components come from `@sproutboat/ikada` (Button, Dialog, Tabs) on Base UI, styled by Tailwind v4 with ikada's theme. The showcase adds only what a stage needs: nine `--stage-*` colours, five type sizes and the motion constants, all in `web/system/tokens.ts`.

## 2. Motion language

**Motion is evidence.** Something moves because something happened: a process started, a request was answered, a measured number changed, or the visitor's pointer is there. If nothing happens, the page is still, except for the swell described below. Five verbs, and an act may not invent a sixth without adding it here:

| Verb | Means | How it moves | Where it lives |
| --- | --- | --- | --- |
| **wake** | a process started | a spring to 1 that overshoots once (stiffness 320, damping 17, about 350 ms) | `stepEnergy` in `system/motion.ts` |
| **settle** | a process was stopped for being idle | a plain exponential fade, about 700 ms. Slower than wake on purpose: sleep is not an event to celebrate | `stepEnergy` |
| **ripple** | one request was answered | one ring going out, 760 ms, fading. One per request, never without one | `Dots.rippleAt` |
| **level** | a measured number changed | eases to the new sample in 420 ms and never passes it. Data does not bounce | `LiveNumber` |
| **cut** | a process was killed (act 02) | off in 80 ms, no easing. To be added by act 02 | not built |

Two supporting motions that are not data and are designed so they cannot be mistaken for it:

- **The swell.** In the hero the whole field rises and falls about 1.4 px, every dot on the same wave. It reads as water because everything shares it. It stops under reduced motion and under the nav's pause button.
- **The pointer's reach.** Sleeping dots within 2.6 cells of the pointer lift a little, in neutral white, so the grid answers the hand before any request does.

One staged entrance exists on the page: the hero, once, on load (label, headline, text, buttons, then the sea; 70 ms apart, 820 ms each, ease-out, 16 px rise with a 6 px blur). Nothing else enters on scroll. Buttons use ikada's press. Text links draw their underline.

**Performance rules.** Canvas for anything with more than a few dozen moving things; DOM animation only on `transform`, `opacity` and `filter`. A scene's loop runs only while its canvas is on screen and something is still moving (`Scene.invalidate`). Pixel ratio is capped at 2. Glows are a pre-rendered sprite stamped per dot, not a gradient or shadow per dot per frame. React renders an act once: live text is written straight to its DOM node (`LiveText`, `LiveNumber`), never through state per frame.

**Reduced motion and pause.** `motionOff()` is true under `prefers-reduced-motion` or the nav's pause button. Scenes then draw states without transitions (a dot is lit or not; a ripple is a ring that fades in place), the swell stops, numbers jump to their value, and the entrance is a 200 ms fade. Nothing is hidden.

Measured (2026-11-13, headless Chrome on the dev Mac, `perf-sample.js`): hero idle, hero wave of 48 and grid wave of 48, 3 s each, at 1440 px and at 390 px with 4x CPU throttling: every frame at 16.7 ms, none over 20 ms, no long tasks. This is not a phone; the builder should repeat it on one.

## 3. Storyboard

### Hero (built)

A dark screen. The headline, "A thousand apps on one small server." Below it, a hairline: the waterline. Under the line the fleet lies on the water as a wide, shallow field of unlit points, moving on a slow swell.

About a second after the first live sample, the page sends one ordinary request to one randomly chosen app. That app starts: a ring spreads on the water (ripple), a light lifts off the surface on a spring (wake) and throws a reflection. A mono line appears at the bottom right: "Your visit started app 281 in 13.1 ms. It stops again after 6 s of silence." Six seconds later the light sinks (settle). The first thing the page does is the product, performed on the visitor's own request.

"Wake 48 apps" sends 48 real requests, nearest the middle first, 22 ms apart: lights rise outward across the field, and fall again together.

Bottom left, the source chip: `LIVE · local preview: 400 copies of one standalone binary on this machine, not sproutd`. Its dot beats once per sample that arrives.

### 01 Fleet (built)

The same fleet from above: a grid, one dot per app, on the right two thirds; words and three readouts on the left.

- **Sweep.** Moving the pointer (or a finger, horizontally) across the grid sends each app it crosses a request. A closing ring shows the request in flight; the answer is a ripple; the dot is lit while the process lives. The newest cold starts print their time above the dot ("5.7 ms") and float away.
- **Wave.** "Send a wave of 48 requests" lights a disc from the centre outward.
- **Readouts.** Running `46 of 400`, Memory `223.0 MB`, Cold start `5.1 ms`, each easing to its sample (level). Under them a trace of memory over the last minute, one point per sample.
- **The line.** One mono sentence says what just happened ("App 173 started in 5.1 ms. 6.0 ms round trip in your browser.") or why something did not ("That is every app this preview will run at once.").
- Then silence: after the idle time the dots dim in the order they were woken and the memory number walks back to zero.

Keyboard and screen reader: the wave button does everything the pointer does; the line is `aria-live`; both canvases have a text alternative.

### 02 Crash arena (to build)

Two apps side by side across the full width, each a single large light with a latency trace running through it like an oscilloscope: **calm** on the left, **bomb** on the right. The page pings both four times a second from the visitor's browser; each answer is a ripple on its light and a point on its trace.

Three attacks, as three buttons under the bomb: **Fill memory**, **Loop forever**, **Crash**.

- *Fill memory*: the bomb's response streams how much it has allocated; a level rises inside its light toward a marked line at 32 MiB (level). At the line the stream breaks: **cut**. The light goes out in 80 ms, the trace shows a gap where pings failed. The next ping that answers says `cold: true`: **wake**, and a mono line: "Killed at 32 MiB. Back in 9 ms."
- *Loop forever*: a ring around the bomb counts real elapsed time toward the 2 s CPU budget. At the budget: cut, gap, wake.
- *Crash*: cut at once.

Through all of it the calm app's trace does not move, and its p50 readout does not change. That flat line is the act.

sproutd makes a crashing app wait before restarting (0.1 s, doubling to 30 s, reset by the first good reply). The act shows that honestly: after a kill the bomb's light shows "restarting in 0.4 s" from the `Retry-After` of the refused ping. The bomb is one app shared by all visitors, so someone else's attack is visible to everyone, and the line says "Another visitor crashed it."

### 03 Pocket server (to build)

A world drawn in the fleet's own language: land as a field of unlit dots. Each running copy of this page that chose to say so is a lit dot in its country, with a count. A check-in arriving is a ripple.

On the left: "This page is one 6 MB file. Take it." Three download buttons with real sizes and checksums (from `build-binaries.ts`, reused from v1), the run command, and the privacy statement in the same size as the body text, not in a footnote:

> Nothing is sent unless you start the copy with `SHARE_COUNTRY=IT` (your choice of country code). It then says "one copy, in IT" once a minute. We store a count per country and nothing else: no address, no id, no time zone. Stop the copy and it leaves the map within three minutes.

When the page is being served by a downloaded copy (`/api/info` says `edition: "standalone"`), the act turns around: "You are running a copy." It shows whether this copy is on the map and how to change that.

### 04 Sleeping crowd (to build)

A full-bleed shared canvas. Visitors draw strokes; other visitors' cursors are small neutral marks. In the top corner sits one dot, the same dot as a fleet app: the worker. Beside it, in mono: `worker asleep · 37 sockets held · 0 MB`.

A stroke goes down. The worker dot wakes (wake); thin lines fan from it to every cursor for 200 ms as the stroke is broadcast (one ripple at each); the readout says `awake · answering`; then, after the idle time, settle, and `asleep · 37 sockets held` again. The sockets never closed. Strokes fade after 60 s, which is also the moderation.

## 4. Data: what is live, what is labelled

Rule: **a number on the page is either measured now, or it carries its source and date beside it.** The `LiveChip` in every act says which, in words, and changes to "Stale" if samples stop.

| Act | Shown | Source | Live? |
| --- | --- | --- | --- |
| Hero, Fleet | which apps are running, how many | the state feed (`FleetSnapshot`, `fleet-contract.ts`), polled | live |
| | memory | the same feed. Local: RSS summed from `ps`. Cloud: see platform work | live |
| | cold start | `Server-Timing: wake` on the answer when the platform sends it, else the browser's round trip | live, per request |
| | round trip | `performance.now()` around `fetch` in the visitor's browser | live |
| | "1,000 apps idle in 1,282 MiB" | `data/benchmarks.json`: sproutd benchmark a22-density, 2026-11-05 | recorded, shown only when there is no live feed, with source and date |
| Arena | latency traces, restarts | the page's own pings; a restart is a `cold: true` answer after failures | live |
| | why it died | inferred from the attack sent, and labelled "expected"; exact with the events feed | live or labelled |
| Pocket | copies per country | check-ins held by the showcase app | live |
| | sizes, checksums, start time | `binaries/binaries.json`, measured by `build-binaries.ts` at build | recorded, with build date |
| Crowd | strokes, cursors, socket count | the app's own WebSocket messages | live |
| | "asleep", "0 MB" | the platform feed | live on Cloud; in a local preview that cannot sleep, the readout says "local preview: the worker stays awake" |

**Local preview.** A laptop has no sproutd, so `serve.ts` runs `fleet-local.ts`: 400 slots, each a copy of `fleet-app` built as a standalone binary. A request to a slot starts a real process (5 to 15 ms on the dev Mac), an idle one is stopped after 6 s, and memory is read from `ps`. Nothing is simulated. It is also not sproutd (no cgroup, no shared runtime, about 5 MB resident per process against about 1.3 MiB on Cloud), and the chip says so wherever the numbers appear.

**No feed at all** (a standalone copy, or Cloud before the platform work lands): `/api/info` returns `fleet: null`, the grid draws dim, the buttons are disabled and the chip reads `RECORDED · 1,000 apps idle in 1,282 MiB on one host. Benchmark a22-density, 2026-11-05; not live here.`

## 5. Platform work

What exists today (read from `sproutd` and `sproutboat-cloud` on 2026-11-13):

- sproutd's admin socket `list` returns every app's state (`asleep`, `waking`, `restarting`, `pid:N`, `suspended`, `dead`); the adapter exposes it as `GET /v1/apps`, operator scope only.
- `tail` streams per-request events (`outcome`: `ok`, `exception`, `exceededCpu`, `exceededWallTime`, ...) and `exception` events for a crashed worker; the adapter exposes it as `GET /v1/tail`, owner scope.
- Hibernation works from compatibility date 2026-11-01; the count of hibernated sockets (`hib_count`) lives in memory and is exposed nowhere.
- Nothing reports memory: not per app, not per host. A heartbeat carries no statistics.
- Nothing is public. Cloud PR #60 drafts `GET /v1/public/density` (aggregate counts and a median), which still needs sproutd to send the numbers.
- `reap-ms` (how long before an idle app is stopped) is one setting for the whole daemon.
- `sproutboat deploy` takes the app's name from its config, so 400 apps means 400 generated configs.

Effort: S up to half a day, M one to two days, L three or more.

| # | Concept | Work | Where | Effort | Without it |
| --- | --- | --- | --- | --- | --- |
| A1 | Fleet | Deploy N copies of `fleet-app` under one showcase account (`fleet-000` ...). A script that writes N configs and runs `sproutboat deploy -c` for each | showcase (script) + main thread to run it | S | no fleet on Cloud |
| A2 | Fleet, Crowd | sproutd reports memory: the sum of private memory over the workers of a given set of apps, and per app on request. Sampled, cached, at most once a second | sproutd + adapter | M | no memory number on Cloud |
| A3 | Fleet, Crowd | `GET /v1/public/showcase/fleet` on the Cloud API: a `FleetSnapshot` for **one allow-listed account**, built from the adapter's `list` and A2, cached for 1 s, CORS open. One letter per app in a fixed order; no names, ids, hosts or per-app numbers. Extends PR #60 | cloud | M | grid cannot show sleep on Cloud |
| A4 | Fleet | A shorter idle time for the showcase apps (about 8 s) so a visitor sees them stop. Needs `reap-ms` per app or per account | sproutd | S to M | dots stay lit for the daemon's default time; the act is slower but still true |
| A5 | Fleet | Per-address rate limit at the edge for `fleet-*` hostnames (about 40 requests a second), and a per-app cap from sproutd's existing limits | edge config | S | abuse relies on N being small enough |
| A6 | Fleet | Optional: `Server-Timing: wake;dur=` on the response that started a worker | sproutd frontend | S | the page shows the browser's round trip only |
| B1 | Arena | None required: the page detects kills and restarts from its own pings | | | |
| B2 | Arena | Optional: a public, read-only event stream for the two arena apps (`exception` and `outcome` from `tail`), so the line can say why the bomb died instead of what was expected | cloud + adapter | M | reason is labelled "expected" |
| B3 | Arena | Confirm what kills a worker besides memory and CPU: an uncaught throw answers 500 and the worker may survive. The "Crash" attack needs a real process death | sproutd owner, 1 h | S | drop the third attack |
| C1 | Pocket | None for the map if the country is the user's own choice (`SHARE_COUNTRY`) | | | |
| C2 | Pocket | Only if the country should come from the address instead: `request.cf.country` at the edge (a GeoIP database on the edge host) | edge + sproutd | M | use C1 |
| C3 | Pocket | Signed and notarised macOS binaries, or the page says the download needs `xattr -d com.apple.quarantine` | release pipeline | M | macOS download shows the command |
| D1 | Crowd | The hibernated-socket count and state for the one canvas app, in the A3 feed (`sockets`, `hibernated`, its state letter, its memory from A2) | sproutd + adapter + cloud | S on top of A2 and A3 | "asleep" cannot be shown; the act loses its point on Cloud |
| D2 | Crowd | Check that `sproutboat dev` accepts hibernatable WebSockets locally | builder, 1 h | S | local preview is labelled "worker stays awake" |

A2 and A3 are the core: one "public showcase stats" feature in sproutd and the Cloud serves Fleet and Sleeping crowd. Crash arena and Pocket server can ship with no platform work.

## 6. Abuse limits

| Surface | Limit | Enforced by |
| --- | --- | --- |
| Fleet, local | 400 slots; at most 120 processes alive (about 640 MB); idle stop at 6 s; per address 160 requests then 40 a second; a start that takes over 3 s is killed | `fleet-local.ts` (`FLEET_LIMITS`), tested |
| Fleet, page | its own budget of 70 then 30 a second, under the server's, so a fast sweep skips dots instead of being refused; a running app is re-asked at most once in 0.9 s | `web/fleet/store.ts` |
| Fleet, Cloud | N chosen so that every app awake at once fits the host (400 at about 1.3 MiB is about 520 MiB); 32 MiB cgroup per app; A5's per-address limit; the state feed is one cached read a second whoever asks | sproutd, edge, A3 |
| Arena | attacks are bounded by the platform itself: 32 MiB cgroup, 2 s of CPU without an answer, 30 s wall. One attack per address every 3 s (rate-limit binding), one in flight at a time for everyone; sproutd's restart backoff bounds a crash loop to one restart per 30 s | sproutd + showcase Worker |
| Pocket | a check-in is 2 bytes of country; per address 4 a minute; a country's count is capped at 500; entries expire 3 minutes after the last check-in and are held in memory, never written | showcase Worker |
| Crowd | no text, only strokes: at most 64 points, coordinates quantised to a 1,024 grid, 8 strokes a second per socket, 200 sockets per room, 1 KiB per message; strokes fade after 60 s; one fixed ink | the canvas app |

## 7. Spec for the builder

Read `web/sections/fleet.tsx` and `web/fleet/` first: act 01 is the reference for all of this.

### File layout

```
src/index.ts            the page's Worker: /healthz, /api/info, static files. Add each act's routes here.
src/guard.ts            client address, JSON replies, rate-limit helper, clamped ints
fleet-app/              the app behind every fleet dot (its own config, types, README)
fleet-contract.ts       the state feed's shape, shared by the local supervisor and the Cloud endpoint
fleet-local.ts          local preview only: real processes, started and stopped
serve.ts                the LAN preview: site/ + /api (sproutboat dev) + /fleet (fleet-local)
build-web.ts            web/ -> site/ : bundle, Tailwind, code panels, build info
regions.ts              PANELS: which real files and regions each "How it works" shows
check.ts, harness.ts    the two apps' HTTP contract, under sproutboat dev and under workerd
web/system/             the design system (below)
web/fleet/              act 01's store and scenes
web/sections/           one file per act
```

A new act adds: `web/<act>/store.ts` (implements `Feed`), `web/<act>/<name>-scene.ts` (extends `Scene`), `web/sections/<act>.tsx`, a `PANELS` entry, its app under `<act>-app/` if it needs one, its routes in `src/index.ts`, its local-preview source in `serve.ts`, its checks in `check.ts`, and its rows in sections 4 to 6 of this file. Then it replaces its row in `web/sections/upcoming.tsx` (delete that file after act 04).

### The system (`web/system/`)

| File | What it gives you |
| --- | --- |
| `tokens.ts` | `color` (typed OKLCH: `ink`, `deep`, `shelf`, `asleep`, `alive`, `aliveCore`, `refused`, `line`), `css(color, alpha)` for canvases, `motion` (every duration and spring). The build writes them to CSS as `--stage-*`; Tailwind has `bg-stage-ink`, `text-stage-alive` and so on. Add a token here, never a raw value in a component |
| `motion.ts` | `motionOff()`, the pause switch, `stepEnergy` (wake and settle), `easeOut`, `clamp01` |
| `scene.ts` | `Scene`: sizing, pixel-ratio cap, on-screen loop, `invalidate()`. `glowSprite()` |
| `feed.ts` | `Feed`: what a store must offer (`status`, `label`, `subscribe`, `onSample`) |
| `live.tsx` | `LiveText`, `LiveNumber`: live values without re-rendering |
| `act.tsx` | `Eyebrow`, `Readout`, `Stage` (mounts a scene), `HowItWorks` (the code dialog) |
| `chrome.tsx` | `Nav`, `Footer`, `Mark`, `LiveChip`, `ACTS` |
| `styles.css` | `.wrap`, `.act`, `.label`, `.num`, `.link`, the type sizes (`text-display`, `text-title`, `text-lede`, `text-readout`, `text-label`), `.rise`, `.appear`, `.swap` |

### An act's anatomy

```tsx
<section id="arena" className="act overflow-clip border-t border-stage-line/8 bg-stage-ink">
  <div className="wrap grid min-h-svh ... lg:h-svh lg:min-h-[46rem] lg:grid-cols-[5fr_8fr]">
    <div>            <Eyebrow number="02">Crash arena</Eyebrow>, h2.text-title, p.text-lede, buttons, <HowItWorks> </div>
    <div>            <Stage create={...} label="..." /> in an absolute box; bleed it if glows reach the edge </div>
    <div>            three <Readout>s, one mono line (aria-live), <LiveChip feed={store} recorded="..."/> </div>
  </div>
</section>
```

Alternate the ground: hero `ink`, Fleet `deep`, Arena `ink`, Pocket `deep`, Crowd `ink`. On a phone the order is words, stage, readouts. Copy: at most about 70 words an act outside the readouts; headings name the thing; buttons say what they send ("Send a wave of 48 requests", not "Try it").

### Rules that are checked or will be asked about

1. Nothing animates unless an event or the pointer caused it. No loops for atmosphere beyond the hero's swell. No entrance on scroll.
2. Every number has a `LiveChip` in the same act and comes from a `Feed`. If the act can run without its live source, it has a recorded sentence with a source and a date.
3. Green is a running process. Use `line` (neutral) for everything else that needs to be seen.
4. Canvas scenes extend `Scene`, allocate nothing per frame, and return `false` from `draw` when nothing is moving.
5. `motionOff()` is respected in every scene and every DOM animation.
6. Works at 390 px with no sideways scroll; stages use `touch-action: pan-y` so the page still scrolls.
7. App code is standard Workers TypeScript (`satisfies ExportedHandler<Env>`, types from `sproutboat types`), runs under workerd through `bun run workerd`, and has checks in `check.ts`.
8. The code shown is cut from the running files by `regions.ts`; a missing region fails the build and the test.
9. Before handing back: screenshots at 390 and 1440, `perf-sample.js` at both with 4x throttling (no frame over 20 ms), reduced motion checked, `bun run typecheck`, `bun test`, `bun run check`, `bun run workerd`, lint and format clean.

### Order of work

1. **02 Crash arena.** No platform work needed. Two apps (`arena-app` with a `MODE` var, deployed twice), a local supervisor that enforces the cap by polling RSS (labelled), the trace scene, the `cut` verb.
2. **03 Pocket server.** Reuse v1's `build-binaries.ts` and `sproutboat.standalone.jsonc` (branch `feat/showcase`). The check-in route and its in-memory counts; the dot-matrix map (generate the land mask at build time from a public-domain outline, commit the generator).
3. **04 Sleeping crowd.** Start with D2. The canvas app is a Durable Object with hibernatable sockets; the "asleep" readout waits on A2, A3 and D1 and shows its labelled local state until then.

## 8. Open questions

Each has a recommendation; none blocks acts 02 and 03.

1. **How many apps in the Cloud fleet, and on which host?** The headline says a thousand; the local preview runs 400. Recommended: a small dedicated showcase host (2 GB) with 1,000 apps, so the headline is literally what is on screen and a wake storm cannot touch tenants. Fallback: 400 on the current host (all awake is about 520 MiB).
2. **Is a public, allow-listed stats endpoint acceptable (A2, A3)?** It exposes one account's app states as letters and one memory total, nothing else. Recommended: yes, as an extension of Cloud PR #60, limited to the showcase account by configuration.
3. **How does a pocket copy say where it is?** Recommended: the person running it types a country code (`SHARE_COUNTRY=IT`). No address is looked up or stored, and the privacy statement stays one sentence. The alternative (country from the address, at the edge) is more automatic and is platform work (C2).
4. **A shorter idle time for showcase apps (A4)?** Recommended: 8 s for the showcase account. With the daemon's default the acts are still true, only slower to watch.
5. **One bomb for everyone, or one per visitor?** Recommended: one shared bomb. A stranger crashing it while you watch the calm line stay flat is the stronger demonstration, and it needs two apps instead of a pool.
6. **macOS downloads.** Recommended: sign and notarise before the page is public (C3); until then show the one-line `xattr` command next to the button.
7. **Where does the page live?** Recommended: `showcase.sproutboat.app`, an ordinary app on Cloud next to its fleet, linked from sproutboat.com. It should not be a page of the marketing site: it has to be running on the thing it shows.
8. **Page weight.** React, Base UI and ikada make the script 373 KB (121 KB gzipped); the whole `site/` is 584 KB. Recommended: keep it. It is the house system, and it still fits a 6 MB binary many times over.
