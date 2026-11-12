# Showcase: design note

A public page that proves four claims about Sproutboat with experiments that run when you press the button. One page, four sections, no slides. Every number on it is measured when you ask, or carries its source and date.

Inspiration only: the Durable Objects playground (real experiment per section, live counters, a "Show the code" panel). Not copied: layout, words, chapters, look.

## What the research found

These shaped the design, and two of them changed what the experiments show.

- **A Cloud app is one process, and the handler runs one request at a time.** Bindings are blocking calls, so two separate HTTP requests can never interleave between a read and a write. A naive read-then-write across separate requests does not double-book on Sproutboat (measured: 40 parallel requests, 0 double-booked in `sproutboat dev`). The same source on workerd does (measured: 40 tickets for 20 seats). The race therefore has two arrivals: fans inside one request (they overlap on any runtime) and fans as separate HTTP requests (where the runtimes differ). The page shows both and says which one it is.
- **`Date.now()` ticks in whole milliseconds** and `performance.now()` is rejected by the Cloud build (abi_rejected, see kitchen-sink `// #region timing`). A query cannot be timed alone, so the page times batches that take at least 10 ms and divides. It says so.
- **"SQLite in process" is the Durable Object's `ctx.storage.sql`**, which sproutd and the standalone binary open inside the worker. D1 on Cloud goes through the host. `sproutboat dev` uses a broker for both, so locally both cost about the same; the page measures wherever it runs and shows what it got.
- **sproutd and the Cloud API have no public aggregate endpoint.** `/v1/hosts` is operator-only and the heartbeat carries no stats. A design and a PR for one are in `sproutboat-cloud` (see "Platform support"). Until it is deployed the density card shows a dated benchmark.
- **The 1,000-app benchmark does not say 200 KiB private per app.** The newest full run (alpha 22, 2026-11-05, 1,000 distinct apps, 1,536 MiB cap) has a median 1,160 KiB private-dirty per worker and 1,281 MiB PSS for the whole fleet. The 207 KiB figure in the notes is the per-app growth after first requests (sproutd #32/#34), a different quantity. The page shows the raw numbers and names which is which.
- **Assets served by the edge do not start the app.** `ready.txt` on the sleeping app is a static file, so a browser can open its connection first and then time only the wake.

## Sections

| # | Experiment | Live | Data source |
| --- | --- | --- | --- |
| 1 | Density and cold start | Wake `showcase-sleeper` from your browser; timings of the first request and of five warm ones; the app's own "I am the first request this process served" flag | Request-time. Fleet size and memory per app: benchmark `a22-density` 2026-11-05 until `GET /v1/public/density` exists |
| 2 | SQLite in the process, and a race | 3 strategies × 2 arrivals; seat map, counters, per-query microseconds D1 vs object | Request-time, from the rows the run stored |
| 3 | Same code on Cloudflare | Identical `src/index.ts` and its two configs; the same race against a Cloudflare URL when `COMPARE_URL` is set | A recorded local run (workerd via wrangler, with versions and date), or live against `COMPARE_URL` |
| 4 | One binary | Real sizes and checksums of the binaries built from this very app; copy-paste run command; which edition serves you | Measured at build (`bun run binaries`), and at run time (`/api/info`) |

Code panels: `build-web.ts` copies the text between `// #region name` markers out of the real source files and highlights it with Shiki. A build fails if a marker is missing. The shown code is the deployed code.

## What each experiment does

**Race.** 300 fans (at most 500) try to buy 100 seats (at most 200). `naive` reads the counter and writes it back through D1. `statement` does it in one SQL statement. `object` runs the same read-then-write as `naive` inside a Durable Object on its own SQLite. The result is counted from stored rows: tickets issued, the sale's own counter, seats given to more than one fan. A sale's rows and object are deleted when the run ends; an abandoned sale is pruned after two minutes; at most 8 sales are open.

**Timings.** Same `SELECT v FROM bench WHERE k = ?` through D1 and through the object's SQLite. Eight batches each; the card shows the batch values and the median in µs.

**Cold start.** The browser opens the sleeping app's host with a static file (no app start), then requests `/ping`. The app answers `cold: true` only when it is the first request its process has served. Cold and warm times are what the browser saw, so they include the network from the visitor.

## Hardening

Per-address rate limit on runs (30 a minute) and on purchases (240 a minute); fans ≤ 500, seats ≤ 200, separate requests ≤ 60, open sales ≤ 8; no unbounded storage (rows deleted at the end, TTL prune, benchmark table has one row); one timing run at a time; `/healthz`; no internals in errors. The only state that survives is one `bench` row.

## Design

Static page on the Afloat mark and `#5BD97A`. Tokens are the `@sproutboat/ikada` OKLCH tokens (`public/theme.css` is copied from `ikada/src/theme.css`), Figtree and JetBrains Mono, light and dark, soft layered surfaces, green only on the primary action and success. Plain HTML, CSS and a module script: no framework and no build for the page beyond `build-web.ts`, because the page is the demo of a tiny app. Honest colours: a double-booked seat is red with a shape and a number, never colour alone.

## Platform support still needed

1. `GET /v1/public/density` on the Cloud API (aggregates only, no names): proposed in sproutboat-cloud, needs sproutd to report `apps_deployed`, `apps_running` and a median private memory in its heartbeat.
2. The deploy of `showcase-sleeper` and the `SLEEPER_URL`, `DENSITY_URL` and `COMPARE_URL` vars (the main thread; nothing here deploys).
3. A Cloudflare deploy for the live side-by-side (user's account).
4. Per-platform binaries: the Linux ones build anywhere; the macOS one needs a Mac.
