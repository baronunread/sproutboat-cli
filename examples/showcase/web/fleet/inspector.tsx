/**
 * The receipt. One app of the fleet, shown the way a sceptic would want it: its own URL, the curl line that
 * calls it, the answer the page last got from it with the platform's headers, and what the host says about its
 * process. Everything here can be checked from a terminal without trusting the page.
 */
import { Button } from "@sproutboat/ikada/button";
import { useEffect, useRef, useState } from "react";
import { LiveText } from "../system/live";
import { ASLEEP, fleet } from "./store";

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });
const kib = (value: number) =>
  value >= 1024 ? `${(value / 1024).toFixed(1)} MiB` : `${value.toLocaleString("en")} KiB`;

/** "running · pid 48213 · since 12:03:41 · 5.2 MB", from the host, or what is known before it answers. */
function processLine(): string {
  const i = fleet.selected;
  if (i < 0) return "";
  const facts = fleet.facts?.i === i ? fleet.facts : null;
  if (!facts) return fleet.states[i] === ASLEEP ? "asleep · no process" : "running";
  if (facts.pid === null) return "asleep · no process · 0 KiB";
  const parts = [facts.state === "w" ? "starting" : "running", `pid ${facts.pid}`];
  if (facts.startedAt) parts.push(`since ${clock(facts.startedAt)}`);
  if (facts.memoryKiB !== null) parts.push(kib(facts.memoryKiB));
  return parts.join(" · ");
}

const curlLine = () => (fleet.selected < 0 ? "" : `curl -si ${fleet.appUrl(fleet.selected)}`);

/** The page's last answer from this app, printed like `curl -si` prints it. */
function receipt(): string {
  const i = fleet.selected;
  if (i < 0) return "";
  const got = fleet.receipts.get(i);
  if (!got)
    return "This page has not called this app yet.\nSend it a request, or run the line above in a terminal\nand watch its dot.";
  return [
    `HTTP ${got.status} · ${got.ms.toFixed(1)} ms in your browser · ${clock(got.at)}`,
    ...got.headers.map(([name, value]) => `${name}: ${value}`),
    got.body.trim(),
  ].join("\n");
}

/** Copy without the Clipboard API when the page is not on https (a LAN preview is not). */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  }
}

export function Inspector() {
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(fleet.selected);
  const [live, setLive] = useState(fleet.status === "live");
  const [copied, setCopied] = useState(false);
  useEffect(
    () =>
      fleet.subscribe(() => {
        setLive(fleet.status === "live");
        setSelected(fleet.selected);
        // The field follows the grid unless someone is typing in it.
        if (input.current && document.activeElement !== input.current && fleet.selected >= 0)
          input.current.value = String(fleet.selected);
      }),
    [],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const pick = (raw: string) => {
    const i = Number(raw);
    if (raw !== "" && Number.isInteger(i)) fleet.select(Math.min(Math.max(i, 0), fleet.apps - 1));
  };
  const ready = live && selected >= 0;

  return (
    <div className="relative z-10 border-t border-stage-line/10 pt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <label className="flex items-center gap-2.5 max-sm:flex-1">
          <span className="label">App</span>
          <input
            ref={input}
            type="number"
            inputMode="numeric"
            min={0}
            max={Math.max(fleet.apps - 1, 0)}
            defaultValue={selected >= 0 ? selected : ""}
            placeholder="–"
            disabled={!live}
            onChange={(event) => pick(event.target.value)}
            className="num h-8 w-[4.5rem] rounded-md border border-stage-line/14 bg-stage-shelf px-2 text-sb-sm text-fg outline-offset-2 transition-colors duration-150 [appearance:textfield] hover:border-stage-line/28 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none"
          />
        </label>
        <p
          className="num min-w-0 flex-1 basis-48 truncate text-sb-sm text-fg-muted max-sm:order-last max-sm:basis-full max-sm:text-[0.75rem]"
          aria-live="polite"
        >
          <LiveText feed={fleet} read={processLine} />
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={!ready}
          onClick={() => void fleet.request(fleet.selected, "sweep")}
        >
          Send it a request
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-md bg-stage-shelf py-1 ps-3 pe-1">
        <span className="num text-sb-sm text-fg-muted select-none" aria-hidden="true">
          $
        </span>
        <code className="num min-w-0 flex-1 overflow-x-auto py-1 text-sb-sm whitespace-nowrap text-fg [scrollbar-width:none]">
          <LiveText feed={fleet} read={curlLine} />
        </code>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready}
          onClick={() => void copy(curlLine()).then(setCopied)}
          className="w-[4.75rem] shrink-0"
        >
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
        <a
          href={ready ? fleet.appUrl(selected) : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!ready}
          className="link num me-2 shrink-0 text-sb-sm aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          Open
        </a>
      </div>

      <pre className="num mt-3 h-[7.5rem] overflow-hidden text-[0.75rem] leading-5 whitespace-pre-wrap text-fg-muted [overflow-wrap:anywhere]">
        <LiveText feed={fleet} read={receipt} />
      </pre>
    </div>
  );
}
