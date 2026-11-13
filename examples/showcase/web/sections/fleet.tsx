/**
 * The hero and act 01 are one section with one stage. The fleet is drawn once, on a canvas that stays in place
 * while the words beside it change from the page's opening claim to the act that lets you test it. An app in
 * the hero is the same mark, in the same cell, as that app in the Fleet act, because it is the same pixels.
 */
import { Button, buttonStyles } from "@sproutboat/ikada/button";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import benchmarks from "../../data/benchmarks.json";
import { ColdLadder } from "../fleet/cold-ladder";
import { GridScene } from "../fleet/grid-scene";
import { Inspector } from "../fleet/inspector";
import { fleet } from "../fleet/store";
import { Eyebrow, HowItWorks, Readout, SproutGlyph, Stage } from "../system/act";
import { LiveChip } from "../system/chrome";
import { LiveNumber, LiveText } from "../system/live";
import { color, css } from "../system/tokens";

// SAFETY: CSSProperties has no index signature for custom properties; "--i" is read by .rise and .appear in styles.css.
const order = (i: number) => ({ "--i": i }) as CSSProperties;
const createGrid = (canvas: HTMLCanvasElement) => new GridScene(canvas);

const density = benchmarks.density;
const idleMiB = Math.round([...density.idlePssKiB].sort((a, b) => a - b)[2]! / 1024);
/** The one recorded figure on the first screen, with where and when it was measured. */
export const RECORDED = `${density.apps.toLocaleString("en")} apps idle in ${idleMiB.toLocaleString("en")} MiB on one host. Benchmark a22-density, ${density.date}; not live here.`;

const awake = () => (fleet.snapshot ? fleet.snapshot.awake : null);
const memory = () => (fleet.snapshot ? fleet.snapshot.memory.usedKiB / 1024 : null);
const coldStart = () => (fleet.lastAnswer?.cold ? (fleet.lastAnswer.wakeMs ?? fleet.lastAnswer.ms) : null);
const whole = (value: number) => String(Math.round(value));
const tenth = (value: number) => (value < 100 ? value.toFixed(1) : String(Math.round(value)));
const ofApps = () => (fleet.apps ? `of ${fleet.apps.toLocaleString("en")}` : "");
const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

const REFUSALS = new Map([
  ["full", "That is every app this preview will run at once. Wait for some to stop."],
  ["rate_limited", "Too many requests from your address. The limit refills in a moment."],
]);
/** Why the last request was not served, for the few seconds it matters. */
function refusal(): string {
  const refused = fleet.lastRefused;
  if (refused && performance.now() - refused.at < 3500) return REFUSALS.get(refused.code) ?? "The request was refused.";
  return "";
}

/**
 * The fleet's last requests as the platform reports them, newest first: from this page, from other visitors and
 * from anybody's terminal. A request this page sent is marked, by the id the platform put on its answer.
 */
function tail(): string {
  const refused = refusal();
  const rows = fleet.recent.slice(refused ? -4 : -5).reverse();
  if (rows.length === 0) return refused || (fleet.status === "live" ? "No request yet. Every app is asleep." : "");
  return [
    ...(refused ? [refused] : []),
    ...rows.map((row) => {
      const what = row.cold ? `cold ${row.wakeMs === null ? "" : `${row.wakeMs.toFixed(1)} ms`}` : "warm";
      return `${clock(row.at)}  app ${String(row.i).padEnd(3)}  ${what.padEnd(12)}  ${row.id}${fleet.mine.has(row.id) ? "  you" : ""}`;
    }),
  ].join("\n");
}

/** What this visit did: the page asked one sleeping app a question, and that started it. */
function VisitLine() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let asked = false;
    return fleet.on((event) => {
      if (event.type === "sample" && !asked && fleet.status === "live" && fleet.apps > 0) {
        asked = true;
        const pick = Math.floor(Math.random() * fleet.apps);
        // The inspector opens on the same app, so its receipt is the proof of this sentence.
        fleet.select(pick);
        setTimeout(() => void fleet.request(pick, "visit"), 900);
      }
      if (event.type === "answer" && event.source === "visit") {
        const took = event.wakeMs ?? event.ms;
        const idle = (fleet.snapshot?.limits.idleMs ?? 0) / 1000;
        setLine(
          event.cold
            ? `Your visit started app ${event.i} in ${took.toFixed(1)} ms. It stops again after ${idle} s of silence.`
            : `Your visit reached app ${event.i}, already running, in ${event.ms.toFixed(1)} ms.`,
        );
      }
    });
  }, []);
  // The line's room is kept before it has anything to say, so nothing under it moves when it arrives.
  return (
    <p className="num min-h-10 text-sb-sm text-fg text-pretty" aria-live="polite">
      {line ? <span className="swap inline-block">{line}</span> : null}
    </p>
  );
}

/** Memory over the last minute: one point per sample received, nothing in between. */
function MemoryTrace() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => {
      const element = canvas.current;
      const ctx = element?.getContext("2d");
      if (!element || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { width, height } = element.getBoundingClientRect();
      if (element.width !== Math.round(width * dpr)) {
        element.width = Math.round(width * dpr);
        element.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      // The time axis, so an almost empty trace still reads as a chart.
      ctx.fillStyle = css(color.line, 0.1);
      ctx.fillRect(0, height - 1, width, 1);
      const samples = fleet.memory;
      const top = Math.max(1024, ...samples) * 1.15;
      const step = width / 149;
      ctx.beginPath();
      samples.forEach((value, index) => {
        const x = width - (samples.length - 1 - index) * step;
        const y = height - 1.5 - (value / top) * (height - 4);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = css(color.alive, 0.9);
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineTo(width, height);
      ctx.lineTo(width - (samples.length - 1) * step, height);
      const fill = ctx.createLinearGradient(0, 0, 0, height);
      fill.addColorStop(0, css(color.alive, 0.22));
      fill.addColorStop(1, css(color.alive, 0));
      ctx.fillStyle = fill;
      ctx.fill();
    };
    draw();
    return fleet.on((event) => event.type === "sample" && draw());
  }, []);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label="Memory held by running apps over the last minute"
      className="mt-3 block h-9 w-full"
    />
  );
}

/** A link to the feed the page itself polls. */
function RawFeed() {
  const [url, setUrl] = useState(fleet.stateUrl);
  useEffect(() => fleet.subscribe(() => setUrl(fleet.stateUrl)), []);
  if (!url) return null;
  return (
    <a className="link num text-sb-sm whitespace-nowrap" href={url} target="_blank" rel="noreferrer">
      Raw feed
    </a>
  );
}

export function Fleet() {
  const scene = useRef<GridScene | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(fleet.status === "live");
  useEffect(() => fleet.on((event) => event.type === "sample" && setLive(fleet.status === "live")), []);
  // The fast poll runs only while the stage is on screen.
  useEffect(() => {
    let release: (() => void) | null = null;
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !release) release = fleet.watch();
      else if (!entry?.isIntersecting && release) {
        release();
        release = null;
      }
    });
    if (stage.current) seen.observe(stage.current);
    return () => {
      seen.disconnect();
      release?.();
    };
  }, []);
  const wave = () => scene.current && fleet.wave(48, scene.current.distanceFromCentre);

  return (
    <section className="relative isolate overflow-x-clip">
      <div className="wrap grid grid-cols-[minmax(0,1fr)] gap-x-14 lg:grid-cols-[minmax(0,6fr)_minmax(0,7fr)]">
        <div
          id="top"
          className="flex flex-col pt-[calc(var(--nav-h)+clamp(2rem,7svh,5rem))] pb-8 lg:col-start-1 lg:row-start-1 lg:min-h-svh lg:pb-6"
        >
          <p className="rise label" style={order(0)}>
            Workers code, compiled to native
          </p>
          <h1 className="rise mt-5 max-w-[14ch] text-display text-balance" style={order(1)}>
            A thousand apps on one small server.
          </h1>
          <p className="rise mt-6 max-w-[34rem] text-lede text-fg-muted text-pretty" style={order(2)}>
            Sproutboat gives every app its own Linux process. It sleeps until a request arrives, wakes in milliseconds,
            and never gets more than 32 MiB. Each dot here is one of them, with a URL you can call yourself.
          </p>
          <div className="rise mt-8 flex flex-wrap gap-3" style={order(3)}>
            <Button size="lg" disabled={!live} onClick={wave}>
              Wake 48 apps
            </Button>
            <a href="https://sproutboat.com/docs" className={buttonStyles({ variant: "secondary", size: "lg" })}>
              Deploy an app
            </a>
          </div>
          <div className="appear mt-10 grid gap-2 lg:mt-auto lg:pt-10" style={order(8)}>
            <VisitLine />
            <LiveChip feed={fleet} recorded={RECORDED} />
          </div>
        </div>

        <div ref={stage} className="appear lg:col-start-2 lg:row-span-2 lg:row-start-1" style={order(4)}>
          <div className="flex flex-col pb-10 lg:sticky lg:top-0 lg:h-svh lg:pt-[calc(var(--nav-h)+1.25rem)] lg:pb-6">
            <p className="label flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="flex items-center gap-1.5">
                <SproutGlyph /> asleep
              </span>
              <span className="flex items-center gap-1.5">
                <SproutGlyph awake /> running
              </span>
              <span className="text-fg">1 dot = 1 app = 1 process = 1 URL</span>
            </p>
            <div className="relative mt-3 h-[min(112vw,30rem)] touch-pan-y lg:h-auto lg:min-h-0 lg:flex-1">
              <div className="absolute -inset-x-12 -inset-y-5">
                <Stage
                  create={createGrid}
                  onScene={(next) => (scene.current = next)}
                  label="The fleet: one mark per app. A lit mark on a stem is an app that is running now. Use the app number field below to inspect one."
                  className="cursor-crosshair"
                />
              </div>
            </div>
            <Inspector />
          </div>
        </div>

        <div
          id="fleet"
          className="flex scroll-mt-0 flex-col border-t border-stage-line/8 pt-12 pb-12 lg:col-start-1 lg:row-start-2 lg:min-h-svh lg:border-t-0 lg:pt-[calc(var(--nav-h)+1.75rem)] lg:pb-6"
        >
          <Eyebrow number="01">Fleet</Eyebrow>
          <h2 className="mt-5 text-title text-balance">Asleep until someone asks.</h2>
          <p className="mt-5 max-w-[32rem] text-lede text-fg-muted text-pretty">
            Sweep the grid or send a wave, and watch the memory follow. Or leave this page out of it: copy a dot’s curl
            line and run it in your own terminal. The dot lights here, and your request lands in the tail with the id
            your terminal printed.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button size="lg" disabled={!live} onClick={wave}>
              Send a wave of 48 requests
            </Button>
            <HowItWorks panel="fleet" title="How the fleet works">
              The grid is one small app deployed many times. The page sends ordinary requests to those apps and reads
              which ones are running; it has no way to start or stop anything itself.
            </HowItWorks>
          </div>

          <div className="mt-10 lg:mt-auto lg:pt-8">
            <div className="grid grid-cols-3 gap-x-6 border-t border-stage-line/10 pt-5">
              <Readout name="Running" unit={<LiveText feed={fleet} read={ofApps} />}>
                <LiveNumber feed={fleet} read={awake} format={whole} />
              </Readout>
              <Readout name="Memory" unit="MB">
                <LiveNumber feed={fleet} read={memory} format={tenth} />
              </Readout>
              <Readout name="Last start" unit="ms">
                <LiveNumber feed={fleet} read={coldStart} format={tenth} />
              </Readout>
            </div>
            <MemoryTrace />

            <div className="mt-5 flex items-baseline justify-between gap-4">
              <p className="label">Tail: every request answered</p>
              <RawFeed />
            </div>
            <pre
              className="num mt-2 h-[5.625rem] overflow-hidden text-[0.6875rem] leading-[1.125rem] text-fg-muted sm:text-[0.75rem]"
              aria-label="The fleet's last five requests"
            >
              <LiveText feed={fleet} read={tail} />
            </pre>
            <p className="sr-only" aria-live="polite">
              <LiveText feed={fleet} read={refusal} />
            </p>

            <div className="mt-5 border-t border-stage-line/10 pt-5">
              <ColdLadder />
            </div>
            <LiveChip feed={fleet} recorded={RECORDED} className="mt-3" />
          </div>
        </div>
      </div>
    </section>
  );
}
