import { Button } from "@sproutboat/ikada/button";
import { useEffect, useRef, useState } from "react";
import { GridScene } from "../fleet/grid-scene";
import { fleet } from "../fleet/store";
import { Eyebrow, HowItWorks, Readout, Stage } from "../system/act";
import { LiveChip } from "../system/chrome";
import { LiveNumber, LiveText } from "../system/live";
import { color, css } from "../system/tokens";
import { RECORDED } from "./hero";

const createGrid = (canvas: HTMLCanvasElement) => new GridScene(canvas);

const awake = () => (fleet.snapshot ? fleet.snapshot.awake : null);
const memory = () => (fleet.snapshot ? fleet.snapshot.memory.usedKiB / 1024 : null);
const coldStart = () => (fleet.lastAnswer?.cold ? (fleet.lastAnswer.wakeMs ?? fleet.lastAnswer.ms) : null);
const whole = (value: number) => String(Math.round(value));
const tenth = (value: number) => (value < 100 ? value.toFixed(1) : String(Math.round(value)));
const ofApps = () => (fleet.apps ? `of ${fleet.apps}` : "");

const REFUSALS = new Map([
  ["full", "That is every app this preview will run at once. Wait for some to stop."],
  ["rate_limited", "Too many requests from your address. The limit refills in a moment."],
]);
function lastEvent(): string {
  const refused = fleet.lastRefused;
  if (refused && performance.now() - refused.at < 3500) return REFUSALS.get(refused.code) ?? "The request was refused.";
  const answer = fleet.lastAnswer;
  if (!answer) return fleet.status === "live" ? "Every app is asleep. Nothing is running." : "";
  const round = `${answer.ms.toFixed(1)} ms round trip in your browser`;
  return answer.cold
    ? `App ${answer.i} started${answer.wakeMs === null ? "" : ` in ${answer.wakeMs.toFixed(1)} ms`}. ${round}.`
    : `App ${answer.i} answered. ${round}.`;
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

export function Fleet() {
  const scene = useRef<GridScene | null>(null);
  const section = useRef<HTMLElement>(null);
  const [live, setLive] = useState(fleet.status === "live");
  useEffect(() => fleet.on((event) => event.type === "sample" && setLive(fleet.status === "live")), []);
  // The fast poll runs only while this act is on screen.
  useEffect(() => {
    let release: (() => void) | null = null;
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !release) release = fleet.watch();
      else if (!entry?.isIntersecting && release) {
        release();
        release = null;
      }
    });
    if (section.current) seen.observe(section.current);
    return () => {
      seen.disconnect();
      release?.();
    };
  }, []);

  return (
    <section id="fleet" ref={section} className="act overflow-clip border-t border-stage-line/8 bg-stage-deep">
      <div className="wrap grid min-h-svh gap-x-14 gap-y-8 pt-[calc(var(--nav-h)+1.75rem)] pb-8 lg:h-svh lg:min-h-[46rem] lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] lg:grid-rows-[auto_1fr_auto] lg:pb-8">
        <div className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Eyebrow number="01">Fleet</Eyebrow>
          <h2 className="mt-5 text-title text-balance">Asleep until someone asks.</h2>
          <p className="mt-5 max-w-[30rem] text-lede text-fg-muted text-pretty">
            Each dot is an app with a process of its own. A request starts it, and a few quiet seconds stop it again.
            Sweep across the grid, or send a wave, and watch the memory follow.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              disabled={!live}
              onClick={() => scene.current && fleet.wave(48, scene.current.distanceFromCentre)}
            >
              Send a wave of 48 requests
            </Button>
            <HowItWorks panel="fleet" title="How the fleet works">
              The grid is one small app deployed many times. The page sends ordinary requests to those apps and reads
              which ones are running; it has no way to start or stop anything itself.
            </HowItWorks>
          </div>
        </div>

        <div className="relative min-h-[22rem] touch-pan-y lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:min-h-0">
          <div className="absolute -inset-12">
            <Stage
              create={createGrid}
              onScene={(next) => (scene.current = next)}
              label="A grid with one dot per app. Lit dots are apps that are running now."
              className="cursor-crosshair"
            />
          </div>
        </div>

        <div className="lg:col-start-1 lg:row-start-3">
          <div className="grid grid-cols-3 gap-x-6 border-t border-stage-line/10 pt-6">
            <Readout name="Running" unit={<LiveText feed={fleet} read={ofApps} />}>
              <LiveNumber feed={fleet} read={awake} format={whole} />
            </Readout>
            <Readout name="Memory" unit="MB">
              <LiveNumber feed={fleet} read={memory} format={tenth} />
            </Readout>
            <Readout name="Cold start" unit="ms">
              <LiveNumber feed={fleet} read={coldStart} format={tenth} />
            </Readout>
          </div>
          <MemoryTrace />
          <p className="num mt-4 min-h-10 text-sb-sm text-fg text-pretty" aria-live="polite">
            <LiveText feed={fleet} read={lastEvent} />
          </p>
          <LiveChip feed={fleet} recorded={RECORDED} className="mt-3" />
        </div>
      </div>
    </section>
  );
}
