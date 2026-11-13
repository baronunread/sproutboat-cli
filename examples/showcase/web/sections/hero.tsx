import { Button, buttonStyles } from "@sproutboat/ikada/button";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import benchmarks from "../../data/benchmarks.json";
import { SeaScene } from "../fleet/sea-scene";
import { fleet } from "../fleet/store";
import { Stage } from "../system/act";
import { LiveChip } from "../system/chrome";

// SAFETY: CSSProperties has no index signature for custom properties; "--i" is read by .rise and .appear in styles.css.
const order = (i: number) => ({ "--i": i }) as CSSProperties;
const createSea = (canvas: HTMLCanvasElement) => new SeaScene(canvas);

const density = benchmarks.density;
const idleMiB = Math.round([...density.idlePssKiB].sort((a, b) => a - b)[2]! / 1024);
/** The one recorded figure on the first screen, with where and when it was measured. */
export const RECORDED = `${density.apps.toLocaleString("en")} apps idle in ${idleMiB.toLocaleString("en")} MiB on one host. Benchmark a22-density, ${density.date}; not live here.`;

/** What this visit did: the page asked one sleeping app a question, and that started it. */
function VisitLine() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let asked = false;
    return fleet.on((event) => {
      if (event.type === "sample" && !asked && fleet.status === "live" && fleet.apps > 0) {
        asked = true;
        const pick = Math.floor(Math.random() * fleet.apps);
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
  if (!line) return <p className="num hidden text-sb-sm text-fg-muted md:block">&nbsp;</p>;
  return <p className="swap num text-sb-sm text-fg text-pretty md:text-end">{line}</p>;
}

export function Hero() {
  const sea = useRef<SeaScene | null>(null);
  const [live, setLive] = useState(fleet.status === "live");
  useEffect(() => fleet.on((event) => event.type === "sample" && setLive(fleet.status === "live")), []);
  return (
    <section id="top" className="act flex flex-col overflow-clip pt-(--nav-h)">
      <div className="wrap relative z-10 pt-[clamp(2rem,7svh,5rem)]">
        <p className="rise label" style={order(0)}>
          Workers code, compiled to native
        </p>
        <h1 className="rise mt-5 max-w-[16ch] text-display text-balance" style={order(1)}>
          A thousand apps on one small server.
        </h1>
        <p className="rise mt-6 max-w-[38rem] text-lede text-fg-muted text-pretty" style={order(2)}>
          Sproutboat gives every app its own Linux process. It sleeps until a request arrives, wakes in milliseconds,
          and never gets more than 32 MiB. The lights below are apps doing exactly that.
        </p>
        <div className="rise mt-8 flex flex-col gap-3 sm:flex-row" style={order(3)}>
          <Button
            size="lg"
            disabled={!live}
            onClick={() => sea.current && fleet.wave(48, sea.current.distanceFromCentre)}
          >
            Wake 48 apps
          </Button>
          <a href="https://sproutboat.com/docs" className={buttonStyles({ variant: "secondary", size: "lg" })}>
            Deploy an app
          </a>
        </div>
      </div>
      <div className="appear relative mt-2 min-h-72 flex-1" style={order(4)}>
        <div className="absolute inset-0">
          <Stage
            create={createSea}
            onScene={(next) => (sea.current = next)}
            label="The fleet seen from the waterline: one light for every app that is running now."
          />
        </div>
      </div>
      <div
        className="appear pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-stage-ink from-40% to-transparent pt-10"
        style={order(8)}
      >
        <div className="wrap grid gap-2 pb-5 md:grid-cols-2 md:items-end md:pb-6">
          <LiveChip feed={fleet} recorded={RECORDED} />
          <VisitLine />
        </div>
      </div>
    </section>
  );
}
