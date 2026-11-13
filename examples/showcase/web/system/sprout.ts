/**
 * The one drawing of "an app" on this page. Every scene that shows an app calls these functions and nothing else,
 * so an app cannot look one way in the hero and another way two screens down.
 *
 * An app is a seed lying on its own waterline. Asleep, that is all there is: a small unlit point. Running, it
 * sprouts: a stem lifts a light off the line and the light throws a reflection back onto it. A request that was
 * answered spreads one ring on the water around it.
 *
 *     asleep        running
 *                     o        head (the light)
 *                     |        stem
 *     ─ · ─         ─ · ─      the waterline, with the seed on it
 *
 * `cell` is the room one app has; every size is a fraction of it, so the same mark works at 12 px in the fleet
 * and at 200 px where an act shows a single app.
 */
import { clamp01, easeOut } from "./motion";
import { glowSprite } from "./scene";
import { color, css, motion } from "./tokens";

export type SproutSize = {
  cell: number;
  /** Radius of the seed. */
  seed: number;
  /** Radius of the light at full energy. */
  head: number;
  /** How far the light rises above the line. */
  lift: number;
  /** Width of the glow stamped behind the light. */
  glow: number;
};

export function sproutSize(cell: number): SproutSize {
  return {
    cell,
    seed: Math.max(1.1, cell * 0.085),
    head: Math.max(1.9, cell * 0.14),
    lift: cell * 0.36,
    glow: cell * 2.9,
  };
}

/** The glow behind a running app's light. One per scene: it is stamped, never recomputed. */
export const sproutGlow = (): HTMLCanvasElement =>
  glowSprite(128, [
    [0, css(color.alive, 0.46)],
    [0.3, css(color.alive, 0.1)],
    [1, css(color.alive, 0)],
  ]);

/** Every seed in one path: what the whole fleet looks like when nothing is running. */
export function drawSeeds(
  ctx: CanvasRenderingContext2D,
  count: number,
  x: (i: number) => number,
  y: (i: number) => number,
  size: SproutSize,
  alpha: number,
): void {
  ctx.fillStyle = css(color.asleep);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const cx = x(i);
    const cy = y(i);
    ctx.moveTo(cx + size.seed, cy);
    ctx.arc(cx, cy, size.seed, 0, 6.2832);
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** The glow of one running app. Call for every running app before any `drawSprout`, under "lighter". */
export function drawSproutGlow(
  ctx: CanvasRenderingContext2D,
  glow: HTMLCanvasElement,
  x: number,
  line: number,
  size: SproutSize,
  energy: number,
): void {
  const shown = Math.min(1, energy);
  const span = size.glow * (0.75 + 0.25 * energy);
  const y = line - size.lift * energy;
  ctx.globalAlpha = shown * 0.9;
  ctx.drawImage(glow, x - span / 2, y - span / 2, span, span);
  // The reflection: the same light, lying flat on the line under it.
  ctx.globalAlpha = shown * 0.42;
  ctx.drawImage(glow, x - span * 0.2, line - span * 0.05, span * 0.4, span * 0.22);
}

/** The stem and the light of one running app, `energy` 0 (asleep) to 1 (running; a wake overshoots once). */
export function drawSprout(
  ctx: CanvasRenderingContext2D,
  x: number,
  line: number,
  size: SproutSize,
  energy: number,
): void {
  const shown = Math.min(1, energy);
  const y = line - size.lift * energy;
  const radius = size.seed + (size.head - size.seed) * energy;
  ctx.fillStyle = css(color.alive);
  ctx.globalAlpha = shown * 0.5;
  ctx.fillRect(x - 0.5, y, 1, line - y);
  ctx.globalAlpha = shown;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 6.2832);
  ctx.fill();
  ctx.fillStyle = css(color.aliveCore);
  ctx.globalAlpha = shown * 0.9;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.45, 0, 6.2832);
  ctx.fill();
}

/** One answered request: a ring spreading on the water, `sinceMs` after the answer arrived. */
export function drawRipple(
  ctx: CanvasRenderingContext2D,
  x: number,
  line: number,
  size: SproutSize,
  sinceMs: number,
  still: boolean,
): void {
  const t = clamp01(sinceMs / motion.rippleMs);
  const radius = still ? size.cell * 0.55 : size.cell * (0.2 + 0.9 * easeOut(t));
  ctx.globalAlpha = (1 - t) * 0.6;
  ctx.strokeStyle = css(color.alive);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(x, line, radius, radius * 0.36, 0, 0, 6.2832);
  ctx.stroke();
}

/** A request on its way to a sleeping app: a ring closing in on the seed. */
export function drawApproach(
  ctx: CanvasRenderingContext2D,
  x: number,
  line: number,
  size: SproutSize,
  now: number,
  still: boolean,
): void {
  const phase = still ? 0.5 : (now % 420) / 420;
  const radius = size.cell * (0.46 - 0.26 * phase);
  ctx.globalAlpha = 0.16 + 0.3 * phase;
  ctx.strokeStyle = css(color.line);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(x, line, radius, radius * 0.36, 0, 0, 6.2832);
  ctx.stroke();
}

/** Corner marks around one app's cell: which app the pointer is over, or which one is being inspected. */
export function drawBrackets(
  ctx: CanvasRenderingContext2D,
  x: number,
  line: number,
  size: SproutSize,
  alpha: number,
): void {
  const half = size.cell * 0.5;
  const arm = Math.max(2.5, size.cell * 0.2);
  // The cell is centred a little above the line, where the sprout stands.
  const cy = line - size.lift * 0.5;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = css(color.line);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = Math.round(x + sx * half) + 0.5;
      const py = Math.round(cy + sy * half) + 0.5;
      ctx.moveTo(px - sx * arm, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py - sy * arm);
    }
  }
  ctx.stroke();
}
