/**
 * Cold start, on one scale: the start this visit just caused, measured now, beside what other platforms
 * publish. The scale is logarithmic (1 ms to 4 s) because the figures span three orders of magnitude. A mark is
 * drawn only where the source gives a number; where it gives words, the row has words and no mark.
 */
import { useEffect, useRef } from "react";
import comparison from "../../data/comparison.json";
import { LiveText } from "../system/live";
import { fleet } from "./store";

type Row = {
  name: string;
  value: string;
  fromMs?: number;
  toMs?: number;
  open?: boolean;
  kind: string;
  by?: string;
  url?: string;
};
const rows: Row[] = comparison.coldStart.rows;

const SCALE_MS = 4000;
/** Where a duration sits on the scale, 0 to 100. */
const at = (ms: number) => Math.min(100, Math.max(0, (Math.log10(Math.max(ms, 1)) / Math.log10(SCALE_MS)) * 100));

const mine = () => (fleet.lastAnswer?.cold ? fleet.lastAnswer : null);
function liveValue(): string {
  const answer = mine();
  if (!answer) return fleet.status === "live" ? "wake a sleeping app to measure it" : "not live here";
  const started = answer.wakeMs === null ? "" : `${answer.wakeMs.toFixed(1)} ms · `;
  return `${started}round trip ${answer.ms.toFixed(1)} ms`;
}

function Track({ from, to, open, ours }: { from?: number; to?: number; open?: boolean; ours?: boolean }) {
  return (
    <span className="relative hidden h-3 sm:block" aria-hidden="true">
      <span className="absolute inset-x-0 top-1/2 h-px bg-stage-line/10" />
      {from !== undefined && to !== undefined ? (
        <span
          className={`absolute top-1/2 h-1.5 min-w-1.5 -translate-y-1/2 rounded-[1px] ${open ? "bg-linear-to-r from-stage-asleep from-55% to-transparent" : ours ? "bg-stage-line" : "bg-stage-asleep"}`}
          style={{ insetInlineStart: `${at(from)}%`, width: `${open ? 100 - at(from) : at(to) - at(from)}%` }}
        />
      ) : null}
    </span>
  );
}

/** This visit's mark: moved by writing its position, not by re-rendering. */
function LiveTrack() {
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const place = () => {
      const answer = mine();
      if (!mark.current) return;
      mark.current.style.opacity = answer ? "1" : "0";
      if (answer) mark.current.style.insetInlineStart = `${at(answer.wakeMs ?? answer.ms)}%`;
    };
    place();
    return fleet.subscribe(place);
  }, []);
  return (
    <span className="relative hidden h-3 sm:block" aria-hidden="true">
      <span className="absolute inset-x-0 top-1/2 h-px bg-stage-line/10" />
      <span
        ref={mark}
        className="absolute top-1/2 size-1.5 -translate-y-1/2 rounded-[1px] bg-stage-line opacity-0 transition-[inset-inline-start] duration-(--stage-level) ease-(--stage-ease-out) motion-reduce:transition-none"
      />
    </span>
  );
}

const ROW =
  "grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-4 py-[0.3125rem] sm:grid-cols-[8.5rem_9rem_minmax(0,1fr)]";

export function ColdLadder() {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="label">Cold start, on one scale</p>
        <p className="num hidden text-[0.6875rem] text-fg-muted sm:block">1 ms to 4 s, logarithmic</p>
      </div>
      <dl className="mt-2 text-[0.8125rem] leading-5">
        <div className={ROW}>
          <dt className="font-semibold text-fg">This fleet, now</dt>
          <LiveTrack />
          <dd className="num truncate text-fg max-sm:col-span-2 max-sm:whitespace-normal" aria-live="polite">
            <LiveText feed={fleet} read={liveValue} />
          </dd>
        </div>
        {rows.map((row) => (
          <div key={row.name} className={ROW}>
            <dt className="text-fg-muted">{row.name}</dt>
            <Track from={row.fromMs} to={row.toMs} open={row.open} />
            <dd className="num text-fg-muted sm:truncate" title={row.by}>
              {row.url ? (
                <a className="link text-fg-muted" href={row.url} target="_blank" rel="noreferrer">
                  {row.value}
                </a>
              ) : (
                <>
                  {row.value} <span className="label ms-1">ours</span>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[0.8125rem] leading-[1.45] text-fg-muted text-pretty">
        The top row is the start on the server, then the round trip from your browser, which includes your network. The
        rest are published figures, read {comparison.readOn}, each linked to its source; “ours” marks our own
        measurement.{" "}
        <a className="link" href="#compared">
          How it compares
        </a>
      </p>
    </div>
  );
}
