import { ACTS } from "../system/chrome";

/** Acts 02 to 04 are specified in DESIGN.md and not built yet. Until they are, the page says so in one place. */
const NEXT = [
  "Attack one app with a memory blow-up, an endless loop or a crash. It dies and restarts in milliseconds while its neighbour's latency line stays flat.",
  "Download this page as one executable. Copies that are running, and whose owners chose to say so, appear on a map by country.",
  "A shared canvas held open by a worker that is asleep. Each stroke wakes it, it answers, and it goes back to sleep.",
];

export function Upcoming() {
  return (
    <section className="border-t border-stage-line/8">
      <div className="wrap py-[clamp(4rem,12svh,8rem)]">
        <p className="label">Next on this page</p>
        <ol className="mt-8 border-b border-stage-line/10">
          {ACTS.slice(1).map((act, index) => (
            <li
              key={act.id}
              id={act.id}
              className="grid scroll-mt-(--nav-h) gap-x-12 gap-y-2 border-t border-stage-line/10 py-7 md:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]"
            >
              <h2 className="flex items-baseline gap-4 text-sb-xl font-semibold tracking-[-0.02em]">
                <span className="num text-sb-sm font-medium text-fg-muted">{act.number}</span>
                {act.name}
              </h2>
              <p className="max-w-[40rem] text-lede text-fg-muted text-pretty">{NEXT[index]}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
