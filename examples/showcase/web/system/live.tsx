/**
 * Text that follows live data without re-rendering React: the component renders once and writes to its own
 * DOM node when the store says something changed. Numbers ease to each new sample (the `level` verb).
 */
import { useEffect, useRef } from "react";
import type { Feed } from "./feed";
import { easeOut, motionOff } from "./motion";
import { motion } from "./tokens";

/** A string computed from the store, rewritten only when it differs. */
export function LiveText({ feed, read, className }: { feed: Feed; read: () => string; className?: string }) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = () => {
      const next = read();
      if (node.current && node.current.textContent !== next) node.current.textContent = next;
    };
    write();
    return feed.subscribe(write);
  }, [feed, read]);
  return <span ref={node} className={className} />;
}

/** A measured number. It eases to each new sample and never passes it. */
export function LiveNumber({
  feed,
  read,
  format,
  className,
}: {
  feed: Feed;
  read: () => number | null;
  format: (value: number) => string;
  className?: string;
}) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let shown: number | null = null;
    let frame = 0;
    const write = (value: number | null) => {
      const text = value === null ? "–" : format(value);
      if (node.current && node.current.textContent !== text) node.current.textContent = text;
    };
    const update = () => {
      const target = read();
      cancelAnimationFrame(frame);
      if (target === null || shown === null || motionOff()) {
        shown = target;
        write(target);
        return;
      }
      const from = shown;
      const began = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - began) / motion.levelMs);
        shown = from + (target - from) * easeOut(t);
        write(shown);
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      if (from !== target) frame = requestAnimationFrame(tick);
    };
    update();
    const off = feed.subscribe(update);
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [feed, read, format]);
  return <span ref={node} className={className} />;
}
