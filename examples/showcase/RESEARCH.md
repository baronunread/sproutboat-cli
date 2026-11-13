# Showcase v2: research

How the best infrastructure demos convince a sceptical developer, how they compare themselves to others, and what that means for this page. Every page below was read on 2026-11-13; client-rendered pages were rendered in headless Chrome (`agent-browser`). Where a number could not be found on the page named, this file says so.

The decisions that follow from this are in [DESIGN.md](DESIGN.md).

## 1. What was looked at

| Demo | URL | What it does |
| --- | --- | --- |
| Cloudflare, "Durable Objects explained live" | https://durable-objects-playground.amini-labs-demo.workers.dev | Twelve steps, each a running demo. Opens with "Every demo here runs for real" and "You're connected via Mestre (MXP)": the visitor's own Cloudflare location, on a globe. Every step has "Show the code". Two steps hand the visitor a URL and a QR code to open on a second device ("Type the same name on your phone"). A sale of 100 seats is run with real requests, with and without the product. A hibernation step shows the object's state as three named boxes (Active, Idle, Hibernated) and a log ("Events appear here"). A dot field has a legend: "asleep / awake · 1 dot = 278 objects" |
| Cloudflare Workers | https://workers.cloudflare.com | No live demo. Claims as headings ("No cold starts"), an isolates-against-containers diagram, real code tabs |
| OpenOrange (Rivet) | https://openorange.dev | A price table against Cloudflare, each row with the two list prices, the instance type used and the arithmetic in a tooltip; one line under it: "Cloudflare and AWS list prices checked 2026-10-08". A limits table "from Cloudflare's docs", linked. A terminal and an app shown side by side with "Served by localhost" changing to "Served by Rivet Cloud" |
| Rivet | https://rivet.dev | Three numbers in the hero (4.99 ms cold starts, 72 KB per Actor, 10.4× cheaper storage). Each has a footnote in the body saying what was measured, on what, and where the other side's number comes from: "The sandbox figure is a provider's documented default allocation as of November 4, 2026, not measured memory use. See the baseline." Two chat windows race: "Cold start 4.99 ms" against "Starting sandbox… 1.27 s" |
| Unikraft Cloud | https://unikraft.cloud | Three figures in the hero (<10 ms cold start, 100K+ VMs per server, 10–100× cost) and "Watch the demo" buttons that open videos. The use-case demo was still "loading demo" after several seconds in headless Chrome; nothing on the page lets a visitor check a figure |
| Firecracker | https://firecracker-microvm.github.io | No demo. Three numbers stated flat: "Boot in <125ms", "<5 MiB overhead per VM", "150 microVMs per second per host" |
| Fly.io | https://fly.io | No live demo on the home page today. Products and regions as text ("fast-booting VMs … in 18 regions"). The globe and the launch animation of earlier versions are gone |
| Vercel Fluid | https://vercel.com/fluid | No live demo. A four-column table: Servers, Serverless, Fluid, in words not numbers ("Cold starts" against "Cold-start prevention") |
| Bun | https://bun.sh | Bar charts for requests per second and memory with the versions of every runtime named ("Node.js v26.7.0"), a "Benchmark →" link to the script beside each, and a button: "Replay this benchmark in real time" |
| Turso | https://turso.tech | Code for creating a database per user; no live counter on the page as rendered |
| Neon | https://neon.com | "Instant operations" as claims; the home page as rendered has no interactive branching demo. Neon's separate branching demo was not found from the home page and is not described here |
| Deno Deploy | https://deno.com/deploy | A banner: "Deno Deploy will be sunset in April 2027". No demo |

## 2. Patterns

### What makes a viewer believe a live demo is real

1. **The demo does something the page could not fake cheaply, with the visitor's own input.** The Durable Objects playground names the visitor's data centre in the first screen. It is one fact, it is about them, and they can check it.
2. **A second device or a second channel.** The playground's strongest moments are "open this URL on your phone": the state on the laptop changes because of something done somewhere else. A terminal is a developer's second device. A `curl` line that changes what the page shows does the same job.
3. **The code is one click away, in place.** "Show the code" sits on every step of the playground; Bun links the benchmark script next to each bar.
4. **The legend says what a mark is.** "1 dot = 278 objects" tells the reader the field is a summary. A page where one dot is one thing should say that just as plainly, because it is the stronger claim.
5. **Raw events, not only a picture.** The hibernation step has a log. A reader trusts a line of text with a time in it more than an animation.
6. **Replay beats a static bar.** Bun's "Replay this benchmark in real time" turns a recorded number into something watched.
7. **Named versions, hosts and dates.** Every credible number above carries what it ran on and when. The ones that do not (Unikraft's "100K+", Vercel's table of adjectives) read as marketing.

Nobody in this set lets the visitor address the demo's units directly. No page gives a URL per dot, a process id, or a raw feed. That is open ground, and it is the thing a fake could not offer.

### How competitors are compared honestly

1. **Say whose number it is and what kind.** Rivet's footnote is the model: its own figure is measured, the other side's is "a provider's documented default allocation … not measured memory use", with a date and a link.
2. **Use the other side's published figures, and link them.** OpenOrange's limits table is Cloudflare's own documentation.
3. **Put the date the prices were checked on the page.**
4. **Show the arithmetic.** OpenOrange's tooltips give instance type, hourly price and headroom, so a reader can redo the sum.
5. **What is missing everywhere: the other side's strengths.** None of these pages says what the competitor gives that they do not. A comparison that does is rarer and more believable.

### How one visual metaphor carries across sections

1. **One mark, one meaning, the whole way down.** The playground's dot is an object in every step; its orange is "the object answered". It never draws an object two ways.
2. **The stage stays, the words change.** The playground is twelve steps over one frame with a fixed step counter. The reader never has to map one picture onto the next.
3. **State as position or light, never as a new shape.** Active, Idle and Hibernated are the same box, lit differently.

Showcase v2 broke the first rule. Its hero drew an app as a light on a stem over water, in perspective, and its Fleet act drew the same app as a dot with a halo, flat, in a grid of a different shape. A wave started in the hero came out as stripes in the grid because the two arranged the same thousand apps differently.

## 3. Competitor numbers

Read on 2026-11-13 unless a publication date is given. "Not published" means it was not on the pages named here; it does not mean it does not exist.

### Cloudflare Workers

| What | Value | Source |
| --- | --- | --- |
| Memory limit | 128 MB per isolate | https://developers.cloudflare.com/workers/platform/limits/ |
| Memory of a loaded isolate | "around 3 MB" when the runtime is shared, against "35 MB" for "a basic Node Lambda running no real code" | https://blog.cloudflare.com/cloud-computing-without-containers/ (published 2018-11-09; Cloudflare's own figure, eight years old) |
| Cold start | "Isolates start in 5 milliseconds"; "zero" when the Worker is loaded during the TLS handshake | same post, and https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/ (2020-07-30). Sharding to warm servers: https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/ (2025-09-26) |
| Startup limit | global scope must run within 1 second | limits page above |
| Idle cost | no charge for duration. Free: 100,000 requests a day. Paid: $5 a month for the account, 10 million requests and 30 million CPU ms included | https://developers.cloudflare.com/workers/platform/pricing/ |
| Where | "Cloudflare's 335+ cities" | https://workers.cloudflare.com |
| Durable Objects | $12.50 per million GB-s while active or unable to hibernate; hibernated objects are not billed for duration | https://developers.cloudflare.com/durable-objects/platform/pricing/ (last updated 2026-10-18) |
| Memory per hibernated WebSocket | not published | |

### Fly Machines

| What | Value | Source |
| --- | --- | --- |
| Smallest Machine | `shared-cpu-1x`, 256 MB, $2.19 per 30 days while started | https://fly.io/docs/about/pricing/ |
| Stopped or suspended | $0.15 per GB of root file system per month, no charge for memory | same page |
| Cold start | "~2+ seconds for common apps"; resume from suspend "a few hundred ms" | https://fly.io/docs/reference/suspend-resume/ |
| Where | Firecracker microVMs "in 18 regions" | https://fly.io |

### AWS Lambda

| What | Value | Source |
| --- | --- | --- |
| Memory | configured, 128 MB to 10,240 MB | https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html |
| Cold start | "varies from under 100 ms to over 1 second", "in under 1% of invocations" | https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html |
| Idle cost | nothing while not running; $0.0000166667 per GB-second while running | https://aws.amazon.com/lambda/pricing/ |
| Where | a Firecracker microVM per execution environment ("<5 MiB overhead per VM", "Boot in <125ms") | https://firecracker-microvm.github.io |
| Host memory per idle function | not published | |

### Vercel Functions (Fluid compute)

| What | Value | Source |
| --- | --- | --- |
| Memory | 2 GB and 1 vCPU by default; up to 4 GB and 2 vCPU on Pro and Enterprise | https://vercel.com/docs/functions/limitations |
| Cold start | no figure published. "Functions are pre-warmed and use bytecode caching to reduce cold starts" | https://vercel.com/fluid, https://vercel.com/docs/fluid-compute |
| Idle cost | active CPU plus provisioned memory "for the entire instance lifetime"; on-demand "costs vary by region", so there is no single price to quote. Nothing while no instance exists | https://vercel.com/docs/fluid-compute/pricing |
| Where | Vercel's regions; many requests share one instance | https://vercel.com/fluid |

### Deno Deploy

| What | Value | Source |
| --- | --- | --- |
| Memory | "a maximum memory allocation of 512MB" | https://docs.deno.com/deploy/pricing_and_limits/ |
| Cold start | not published on the pages read | |
| Cost | plans at $0, $20 and $200 a month | https://deno.com/deploy/pricing |
| Status | "Deno Deploy will be sunset in April 2027" | banner on https://deno.com/deploy; announcement https://deno.com/blog/cloudflare (2026-10-09) |

### OpenOrange (Rivet)

| What | Value | Source |
| --- | --- | --- |
| What runs | "Your Worker runs in a Node.js process" in your container; Durable Objects are Rivet Actors | https://openorange.dev/docs/architecture/ |
| Memory limit | "Up to your machine's memory. The Node.js heap is up to about 4 GB by default" | https://openorange.dev |
| Memory per idle object, cold start | not published for OpenOrange. Rivet publishes 72.4 KB per Actor and 4.99 ms p99 cold start for its own Actors on the Rust SDK, which is a different runtime | https://rivet.dev |
| Memory per hibernated WebSocket object | about 1 MB. **Our measurement**, not theirs: sproutd PR #110, `benchmarks/ws-idle-2026-11-13` | sproutd (private) |
| Cost | your cloud bill; they quote $0.0094 per GB-hour for object compute on AWS Graviton with 40% headroom, "list prices checked 2026-10-08" | https://openorange.dev |
| Where | your AWS, Google Cloud or Azure account, Rivet Cloud, or self-hosted (Apache 2.0) | https://openorange.dev |

### A Node.js process, or a container of one

| What | Value | Source |
| --- | --- | --- |
| Memory, idle | 48.5 MiB resident for a bare `node:http` server. **Our measurement**: Node 26.5.1, macOS arm64, 2026-11-13, one run, not in a container and not on Linux | `node -e 'require("http").createServer((q,s)=>s.end("ok")).listen(0, ...)'`, `process.memoryUsage().rss` after 1.5 s |
| | 35 MB for "a basic Node Lambda running no real code" | Cloudflare, 2018-11-09 (above) |
| Start to first answer | 31 to 38 ms. **Our measurement**, same machine, three runs, spawn to first HTTP reply | |
| Docker's own overhead per container | not measured and not found as a published figure | |

### Sproutboat (ours)

| What | Value | Source |
| --- | --- | --- |
| Host memory per idle app | about 1.28 MiB at 1,000 apps | sproutd #102, `benchmarks/gc-limit-2026-11-12`; consistent with `a22-density-2026-11-05` (1,000 apps idle in 1,282 MiB, in `data/benchmarks.json`) |
| Kept per app after first requests | 122 KiB | sproutd #102 |
| Standalone binary | 5 to 7 MB, 7 ms to first answer | `build-binaries.ts` (v1 branch); 5 to 15 ms measured in this preview on the dev Mac |
| Per hibernated WebSocket | 5 to 9 KiB | sproutd #110, `benchmarks/ws-idle-2026-11-13` |
| Wake | 4 to 60 ms depending on socket count | sproutd #111 |

The two November benchmarks are on unmerged sproutd branches and were not read while writing this; the figures are as given by the project owner. Whoever builds the comparison act must check each sentence against the benchmark's own README before the page is public.

## 4. What this means for the page

1. **Make every dot addressable.** A URL, a `curl` line, the response's headers. Nobody else does it and a fake cannot.
2. **Let the terminal be the second device.** A request sent from outside the page must show up on the page: the dot lights, and the request's id appears in a tail.
3. **Publish the raw feed** the page itself reads.
4. **One mark for an app, one arrangement of the fleet, one stage.** The hero and the Fleet act share a single canvas.
5. **Say "1 dot = 1 app = 1 process = 1 URL"** in a legend.
6. **Compare in two groups**, because the platforms answer different questions. On a server you run (Sproutboat, a Node process, OpenOrange self-hosted) the question is memory per idle app, and it is apples to apples. On someone else's servers (Workers, Lambda, Fly, Vercel, Deno) idle memory is the provider's problem and mostly unpublished; the questions are cold start, price while idle, and limits.
7. **Footnote every figure the way Rivet does**: measured or documented, by whom, on what, when, with a link. And add the column nobody else has: what the other platform gives that Sproutboat does not.
