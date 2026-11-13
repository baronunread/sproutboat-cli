/** The page's fixed parts: the mark, the nav, the footer, and the label that says where a number comes from. */
import { buttonStyles } from "@sproutboat/ikada/button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Feed, FeedStatus } from "./feed";
import { motionOff, motionPaused, setMotionPaused } from "./motion";

/** The Afloat mark: two leaves cut by a waterline. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="var(--stage-alive)"
        d="M1.92 15A8.4 8.4 0 0 1 2.8 8.4A11 11 0 0 1 10.73 15ZM11.36 15A16 16 0 0 1 20.8 3.2A11.5 11.5 0 0 1 21.28 15ZM11.4 21A8.4 8.4 0 0 1 2.51 16.5L11.23 16.5A11 11 0 0 1 11.4 21ZM11.4 21A16 16 0 0 1 11.16 16.5L20.31 16.5A11.5 11.5 0 0 1 11.4 21ZM11.4 21L11.23 16.5L11.16 16.5Z"
      />
    </svg>
  );
}

export const ACTS = [
  { id: "fleet", number: "01", name: "Fleet" },
  { id: "pocket", number: "02", name: "Pocket server" },
  { id: "selfhost", number: "03", name: "Self-host" },
] as const;

/** What the nav lists: the three acts, then the comparison they all point to. */
const SECTIONS = [...ACTS, { id: "compared", number: "04", name: "Compared" }] as const;

export function Nav() {
  const [current, setCurrent] = useState<string>("");
  const [paused, setPaused] = useState(motionPaused());
  useEffect(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setCurrent(entry.target.id);
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const id of ["top", ...SECTIONS.map((act) => act.id)]) {
      const element = document.getElementById(id);
      if (element) seen.observe(element);
    }
    return () => seen.disconnect();
  }, []);
  return (
    <header className="fixed inset-x-0 top-0 z-40 h-(--nav-h) border-b border-stage-line/6 bg-stage-ink/72 backdrop-blur-md">
      <nav className="wrap flex h-full items-center gap-6" aria-label="Sections">
        <a
          href="#top"
          className="-ms-1 flex items-center gap-2.5 rounded-md p-1 outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Mark className="size-6" />
          <span className="text-[0.9375rem] font-semibold tracking-[-0.015em]">Sproutboat</span>
        </a>
        <ol className="ms-auto hidden items-center gap-1 lg:flex">
          {SECTIONS.map((act) => (
            <li key={act.id}>
              <a
                href={`#${act.id}`}
                aria-current={current === act.id ? "true" : undefined}
                className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sb-sm text-fg-muted outline-offset-2 transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus aria-[current]:text-fg"
              >
                <span className="num text-[0.6875rem] text-fg-muted/70 transition-colors duration-150 group-aria-[current]:text-stage-alive">
                  {act.number}
                </span>
                {act.name}
              </a>
            </li>
          ))}
        </ol>
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => {
            setMotionPaused(!paused);
            setPaused(!paused);
          }}
          className="ms-auto grid size-9 place-items-center rounded-md text-fg-muted outline-offset-2 transition-[color,background-color,scale] duration-150 hover:bg-stage-line/8 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus active:scale-[0.96] lg:ms-0"
        >
          <span className="sr-only">{paused ? "Resume motion" : "Pause motion"}</span>
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true" fill="currentColor">
            {paused ? <path d="M4.5 2.6v10.8L13 8z" /> : <path d="M4 2.5h2.6v11H4zM9.4 2.5H12v11H9.4z" />}
          </svg>
        </button>
        <a href="https://sproutboat.com/docs" className={buttonStyles({ variant: "secondary", size: "sm" })}>
          Read the docs
        </a>
      </nav>
    </header>
  );
}

const STATUS_WORD = {
  connecting: "Connecting",
  live: "Live",
  stale: "Stale",
  offline: "Recorded",
} satisfies Record<FeedStatus, string>;

/**
 * Says where the numbers beside it come from. The dot beats once for every sample that actually arrives, so
 * a feed that stops is seen to stop; after a few seconds without one the word changes to "Stale".
 */
export function LiveChip({
  feed,
  recorded,
  className = "",
}: {
  feed: Feed;
  /** The dated, sourced sentence shown when there is no live source here. */
  recorded: string;
  className?: string;
}) {
  const beat = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<FeedStatus>(feed.status);
  const [label, setLabel] = useState(feed.label);
  useEffect(
    () =>
      feed.onSample(() => {
        setStatus(feed.status);
        setLabel(feed.label);
        if (feed.status === "live" && !motionOff())
          beat.current?.animate(
            [
              { transform: "scale(1)", opacity: 0.5 },
              { transform: "scale(2.8)", opacity: 0 },
            ],
            { duration: 380, easing: "ease-out" },
          );
      }),
    [feed],
  );
  const tone = status === "live" ? "bg-stage-alive" : status === "stale" ? "bg-stage-refused" : "bg-stage-asleep";
  return (
    <p className={`flex max-w-full items-start gap-2.5 text-sb-sm text-fg-muted ${className}`}>
      <span className="relative mt-[0.4375rem] grid size-1.5 shrink-0 place-items-center">
        <span ref={beat} className={`absolute inset-0 rounded-full opacity-0 ${tone}`} />
        <span className={`size-1.5 rounded-full ${tone}`} />
      </span>
      <span className="min-w-0 text-pretty">
        <span className="label text-fg">{STATUS_WORD[status]}</span>
        <span className="mx-2 text-fg-muted/50">·</span>
        {status === "offline" ? recorded : status === "connecting" ? "waiting for the first sample" : label}
      </span>
    </p>
  );
}

export function Footer({ children }: { children?: ReactNode }) {
  return (
    <footer className="border-t border-stage-line/8 bg-stage-deep">
      <div className="wrap flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Mark className="size-6" />
          <p className="text-sb-base text-fg-muted">The same source runs on Cloudflare Workers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sb-base">
          <a className="link" href="https://sproutboat.com/docs">
            Docs
          </a>
          <a className="link" href="https://github.com/baronunread/sproutboat-cli/tree/main/examples/showcase">
            This page's source
          </a>
          {children}
        </div>
      </div>
    </footer>
  );
}
