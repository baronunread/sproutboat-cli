/**
 * The fleet: one sprout per app (system/sprout.ts), in one grid, on the one canvas the hero and the Fleet act
 * share. Sweeping the pointer across apps sends each a real request; a click or a tap picks one to inspect.
 */
import { clamp01, easeOut } from "../system/motion";
import { Scene } from "../system/scene";
import {
  drawApproach,
  drawBrackets,
  drawRipple,
  drawSeeds,
  drawSprout,
  drawSproutGlow,
  sproutGlow,
  sproutSize,
  type SproutSize,
} from "../system/sprout";
import { color, css } from "../system/tokens";
import { Dots } from "./dots";
import { AWAKE, fleet } from "./store";

/**
 * The canvas is this much larger than the grid, so a glow at the edge fades out instead of being cut. The page
 * sets the same outsets on the canvas's box (sections/fleet.tsx).
 */
export const GRID_BLEED = { x: 48, y: 20 };

export class GridScene extends Scene {
  private readonly dots = new Dots(
    () => this.invalidate(),
    (a, b) =>
      Math.abs((a % this.cols) - (b % this.cols)) >= 3 ||
      Math.abs(Math.floor(a / this.cols) - Math.floor(b / this.cols)) >= 2,
  );
  private readonly glow = sproutGlow();
  private cols = 1;
  private rows = 1;
  private size: SproutSize = sproutSize(10);
  private originX = 0;
  private originY = 0;
  private pointer: { x: number; y: number } | null = null;
  private drawn = -1;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    this.own(this.dots.connect());
    this.own(
      fleet.subscribe(() => {
        if (fleet.apps !== this.drawn) this.layout();
        this.invalidate();
      }),
    );
    const move = (event: PointerEvent) => this.sweep(event);
    const down = (event: PointerEvent) => {
      this.sweep(event);
      const i = this.at(event.offsetX, event.offsetY);
      if (i >= 0) fleet.select(i);
    };
    const leave = () => {
      this.pointer = null;
      this.invalidate();
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointercancel", leave);
    this.own(() => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointercancel", leave);
    });
    this.ready();
  }

  protected layout(): void {
    const n = Math.max(fleet.apps, 1);
    this.drawn = fleet.apps;
    const width = this.width - GRID_BLEED.x * 2;
    const height = this.height - GRID_BLEED.y * 2;
    // The column count that gives the largest cell for this box.
    let best = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cell = Math.min(width / cols, height / rows);
      if (cell > best) [best, this.cols, this.rows] = [cell, cols, rows];
    }
    this.size = sproutSize(best);
    this.originX = (this.width - this.cols * best) / 2 + best / 2;
    // A cell's waterline sits low in it: the sprout needs the room above.
    this.originY = (this.height - this.rows * best) / 2 + best * 0.7;
  }

  private readonly x = (i: number): number => this.originX + (i % this.cols) * this.size.cell;
  private readonly y = (i: number): number => this.originY + Math.floor(i / this.cols) * this.size.cell;

  private at(x: number, y: number): number {
    const cell = this.size.cell;
    const col = Math.floor((x - this.originX + cell / 2) / cell);
    const row = Math.floor((y - this.originY + cell * 0.7) / cell);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    const i = row * this.cols + col;
    return i < fleet.apps ? i : -1;
  }

  /** Every app whose cell the pointer crossed since its last position gets a request. */
  private sweep(event: PointerEvent): void {
    const next = { x: event.offsetX, y: event.offsetY };
    const from = this.pointer ?? next;
    const steps = Math.max(1, Math.ceil(Math.hypot(next.x - from.x, next.y - from.y) / (this.size.cell / 2)));
    for (let step = 1; step <= steps; step++) {
      const i = this.at(from.x + ((next.x - from.x) * step) / steps, from.y + ((next.y - from.y) * step) / steps);
      if (i >= 0) void fleet.request(i, "sweep");
    }
    this.pointer = next;
    this.invalidate();
  }

  /** How far app i is from the middle of the grid, in cells: a wave starts there. */
  distanceFromCentre = (i: number): number =>
    Math.hypot((i % this.cols) - (this.cols - 1) / 2, Math.floor(i / this.cols) - (this.rows - 1) / 2);

  protected draw(now: number, dt: number, still: boolean): boolean {
    const { ctx, size } = this;
    const moving = this.dots.step(now, dt, still);
    ctx.clearRect(0, 0, this.width, this.height);
    const n = fleet.apps;
    if (n === 0) return false;

    drawSeeds(ctx, n, this.x, this.y, size, fleet.status === "live" ? 0.62 : 0.3);

    // Light first, additively, so neighbours' glows add up the way light does.
    ctx.globalCompositeOperation = "lighter";
    for (const i of this.dots.active) {
      const energy = this.dots.energy[i] ?? 0;
      if (energy > 0.01) drawSproutGlow(ctx, this.glow, this.x(i), this.y(i), size, energy);
    }
    ctx.globalCompositeOperation = "source-over";

    for (const i of this.dots.active) {
      const x = this.x(i);
      const y = this.y(i);
      const ripple = this.dots.rippleAt[i] ?? 0;
      if (ripple) drawRipple(ctx, x, y, size, now - ripple, still);
      if (fleet.inFlight[i] && fleet.states[i] !== AWAKE) drawApproach(ctx, x, y, size, now, still);
      const energy = this.dots.energy[i] ?? 0;
      if (energy > 0.01) drawSprout(ctx, x, y, size, energy);
      const refused = this.dots.refusedAt[i] ?? 0;
      if (refused) {
        ctx.globalAlpha = (1 - clamp01((now - refused) / 900)) * 0.9;
        ctx.strokeStyle = css(color.refused);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(x, y, size.cell * 0.36, size.cell * 0.13, 0, 0, 6.2832);
        ctx.stroke();
      }
    }

    // Which app the pointer is over, and which one the inspector shows.
    if (this.pointer) {
      const over = this.at(this.pointer.x, this.pointer.y);
      if (over >= 0 && over !== fleet.selected) drawBrackets(ctx, this.x(over), this.y(over), size, 0.34);
    }
    if (fleet.selected >= 0 && fleet.selected < n)
      drawBrackets(ctx, this.x(fleet.selected), this.y(fleet.selected), size, 0.9);

    // How long the newest cold starts took, where they happened.
    if (size.cell >= 13) {
      ctx.font = `500 ${Math.min(12, Math.max(10, size.cell * 0.5))}px "JetBrains Mono Variable", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = css(color.line);
      for (const tag of this.dots.tags) {
        const t = clamp01((now - tag.at) / 1400);
        const alpha = t < 0.15 ? t / 0.15 : 1 - easeOut((t - 0.15) / 0.85);
        const x = this.x(tag.i);
        const y = this.y(tag.i) - size.cell * 0.95 - (still ? 0 : 8 * easeOut(t));
        // A plate of the ground behind the figure: in a wave it sits over its neighbours' light.
        const half = ctx.measureText(tag.text).width / 2 + 4;
        ctx.globalAlpha = alpha * 0.82;
        ctx.fillStyle = css(color.ink);
        ctx.fillRect(x - half, y - 11, half * 2, 15);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = css(color.line);
        ctx.fillText(tag.text, x, y);
      }
    }
    ctx.globalAlpha = 1;
    return moving;
  }
}
