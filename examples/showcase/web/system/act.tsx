/**
 * The parts every act is built from. An act is one full-bleed screen: a stage (a canvas scene), a column of
 * words, a few readouts, a label saying where the numbers come from, and a way to read the real code.
 */
import { Button } from "@sproutboat/ikada/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@sproutboat/ikada/dialog";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@sproutboat/ikada/tabs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Scene } from "./scene";

/** "01 · Fleet": the act's number in the live colour, its name beside it. */
export function Eyebrow({ number, children }: { number: string; children: ReactNode }) {
  return (
    <p className="label flex items-center gap-3">
      <span className="num text-stage-alive">{number}</span>
      <span className="h-px w-6 bg-stage-line/20" />
      {children}
    </p>
  );
}

/**
 * The app mark (system/sprout.ts) as an inline picture, for a legend or a sentence: a seed on its waterline,
 * or a light lifted off it on a stem.
 */
export function SproutGlyph({ awake = false }: { awake?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <path d="M2 12.5h12" stroke="var(--stage-line)" strokeOpacity="0.28" />
      {awake ? (
        <>
          <path d="M8 5.5v7" stroke="var(--stage-alive)" strokeOpacity="0.55" />
          <circle cx="8" cy="5" r="2.6" fill="var(--stage-alive)" />
        </>
      ) : (
        <circle cx="8" cy="12.5" r="1.7" fill="var(--stage-asleep)" />
      )}
    </svg>
  );
}

/** One measured value with its name above and its unit beside. */
export function Readout({ name, unit, children }: { name: string; unit?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="label">{name}</p>
      <p className="mt-2 flex items-baseline gap-1.5 whitespace-nowrap">
        <span className="num text-readout text-fg">{children}</span>
        {unit ? <span className="num text-sb-sm text-fg-muted">{unit}</span> : null}
      </p>
    </div>
  );
}

/**
 * Mounts a scene on a canvas for as long as the component lives. `onScene` hands the instance out for the
 * few things the DOM needs from it (a wave needs to know where the centre is).
 */
export function Stage<S extends Scene>({
  create,
  onScene,
  label,
  className = "",
}: {
  create: (canvas: HTMLCanvasElement) => S;
  onScene?: (scene: S | null) => void;
  /** What the canvas shows, for someone who cannot see it. */
  label: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const scene = create(canvas.current);
    onScene?.(scene);
    return () => {
      onScene?.(null);
      scene.destroy();
    };
    // A scene is created once per mount: `create` and `onScene` are stable by contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={canvas} role="img" aria-label={label} className={`block size-full ${className}`} />;
}

type Block = { label: string; note?: string; html: string };

/**
 * "How it works": the act's real source, cut from the files at build time (build-web.ts fails if a region is
 * missing), behind one quiet button. Loaded when opened.
 */
export function HowItWorks({ panel, title, children }: { panel: string; title: string; children: ReactNode }) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const load = (open: boolean) => {
    if (!open || blocks) return;
    void fetch("code.json")
      .then((response) => response.json())
      .then((code: { panels: Record<string, Block[]> }) => setBlocks(code.panels[panel] ?? []));
  };
  return (
    <Dialog onOpenChange={load}>
      <DialogTrigger render={<Button variant="ghost" />}>How it works</DialogTrigger>
      <DialogContent className="max-h-[min(86svh,48rem)] max-w-3xl overflow-y-auto">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{children}</DialogDescription>
        {blocks && blocks.length > 0 ? (
          <Tabs defaultValue={blocks[0]?.label} className="mt-5 min-w-0">
            <TabsList>
              {blocks.map((block) => (
                <TabsTab key={block.label} value={block.label}>
                  {block.label}
                </TabsTab>
              ))}
            </TabsList>
            {blocks.map((block) => (
              <TabsPanel key={block.label} value={block.label} className="mt-3">
                {block.note ? <p className="mb-3 text-sb-sm text-fg-muted">{block.note}</p> : null}
                <div
                  className="code overflow-hidden rounded-lg bg-code-bg"
                  // The HTML is Shiki's, made at build time from files in this repository.
                  dangerouslySetInnerHTML={{ __html: block.html }}
                />
              </TabsPanel>
            ))}
          </Tabs>
        ) : (
          <p className="mt-5 text-sb-sm text-fg-muted">Loading the source…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
