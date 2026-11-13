/**
 * Section A's stage: the fleet from above. One dot per app. Sweeping the pointer across dots sends each app a
 * real request; the dot shows the request leaving (a ring closing in), the answer arriving (a ring going out)
 * and the process being alive (lit) until the platform stops it.
 */
import { clamp01, easeOut } from "../system/motion";
import { glowSprite, Scene } from "../system/scene";
import { color, css, motion } from "../system/tokens";
import { Dots } from "./dots";
import { AWAKE, fleet } from "./store";

/** The canvas is this much larger than the grid on every side, so a glow at the edge fades out instead of being cut. */
export const GRID_BLEED = 48;

export class GridScene extends Scene {
  private readonly dots = new Dots(
    () => this.invalidate(),
    (a, b) =>
      Math.abs((a % this.cols) - (b % this.cols)) >= 3 ||
      Math.abs(Math.floor(a / this.cols) - Math.floor(b / this.cols)) >= 2,
  );
  private readonly glow = glowSprite(128, [
    [0, css(color.alive, 0.55)],
    [0.3, css(color.alive, 0.12)],
    [1, css(color.alive, 0)],
  ]);
  private cols = 1;
  private rows = 1;
  private cell = 10;
  private originX = 0;
  private originY = 0;
  private pointer: { x: number; y: number } | null = null;
  private drawn = -1;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    this.own(this.dots.connect());
    this.own(fleet.subscribe(() => fleet.apps !== this.drawn && (this.layout(), this.invalidate())));
    const move = (event: PointerEvent) => this.sweep(event);
    const leave = () => {
      this.pointer = null;
      this.invalidate();
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", move);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointercancel", leave);
    this.own(() => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerdown", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointercancel", leave);
    });
    this.ready();
  }

  protected layout(): void {
    const n = Math.max(fleet.apps, 1);
    this.drawn = fleet.apps;
    // The column count that gives the largest cell for this box.
    let best = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cell = Math.min((this.width - GRID_BLEED * 2) / cols, (this.height - GRID_BLEED * 2) / rows);
      if (cell > best) [best, this.cols, this.rows] = [cell, cols, rows];
    }
    this.cell = best;
    this.originX = (this.width - this.cols * best) / 2 + best / 2;
    this.originY = (this.height - this.rows * best) / 2 + best / 2;
  }

  private x(i: number): number {
    return this.originX + (i % this.cols) * this.cell;
  }
  private y(i: number): number {
    return this.originY + Math.floor(i / this.cols) * this.cell;
  }
  private at(x: number, y: number): number {
    const col = Math.floor((x - this.originX + this.cell / 2) / this.cell);
    const row = Math.floor((y - this.originY + this.cell / 2) / this.cell);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    const i = row * this.cols + col;
    return i < fleet.apps ? i : -1;
  }

  /** Every app whose cell the pointer crossed since its last position gets a request. */
  private sweep(event: PointerEvent): void {
    const box = this.canvas.getBoundingClientRect();
    const next = { x: event.clientX - box.left, y: event.clientY - box.top };
    const from = this.pointer ?? next;
    const steps = Math.max(1, Math.ceil(Math.hypot(next.x - from.x, next.y - from.y) / (this.cell / 2)));
    for (let step = 1; step <= steps; step++) {
      const i = this.at(from.x + ((next.x - from.x) * step) / steps, from.y + ((next.y - from.y) * step) / steps);
      if (i >= 0) void fleet.request(i, "sweep");
    }
    this.pointer = next;
    this.invalidate();
  }

  /** The centre of the grid in grid units, for a wave that starts in the middle. */
  distanceFromCentre = (i: number): number =>
    Math.hypot((i % this.cols) - (this.cols - 1) / 2, Math.floor(i / this.cols) - (this.rows - 1) / 2);

  protected draw(now: number, dt: number, still: boolean): boolean {
    const { ctx, cell } = this;
    const moving = this.dots.step(now, dt, still);
    ctx.clearRect(0, 0, this.width, this.height);
    const n = fleet.apps;
    if (n === 0) return false;
    const rest = Math.max(1.1, cell * 0.085);
    const lit = Math.max(2.2, cell * 0.17);

    // Every app at rest, in one path.
    ctx.fillStyle = css(color.asleep);
    ctx.globalAlpha = fleet.status === "live" ? 0.62 : 0.3;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = this.x(i);
      ctx.moveTo(x + rest, this.y(i));
      ctx.arc(x, this.y(i), rest, 0, 6.2832);
    }
    ctx.fill();

    // The pointer's reach: sleeping dots near it lift a little, so the grid answers before any request does.
    if (this.pointer) {
      const reach = cell * 2.6;
      const col = Math.round((this.pointer.x - this.originX) / cell);
      const row = Math.round((this.pointer.y - this.originY) / cell);
      ctx.fillStyle = css(color.line);
      for (let r = row - 3; r <= row + 3; r++) {
        for (let c = col - 3; c <= col + 3; c++) {
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows || r * this.cols + c >= n) continue;
          const x = this.originX + c * cell;
          const y = this.originY + r * cell;
          const near = 1 - Math.hypot(x - this.pointer.x, y - this.pointer.y) / reach;
          if (near <= 0) continue;
          ctx.globalAlpha = near * near * 0.5;
          ctx.beginPath();
          ctx.arc(x, y, rest * (1 + near * 0.7), 0, 6.2832);
          ctx.fill();
        }
      }
    }

    // Light first, additively, so neighbours' glows add up the way light does.
    ctx.globalCompositeOperation = "lighter";
    const span = cell * 3.4;
    for (const i of this.dots.active) {
      const energy = this.dots.energy[i] ?? 0;
      if (energy <= 0.01) continue;
      ctx.globalAlpha = Math.min(1, energy) * 0.9;
      const size = span * (0.75 + 0.25 * energy);
      ctx.drawImage(this.glow, this.x(i) - size / 2, this.y(i) - size / 2, size, size);
    }
    ctx.globalCompositeOperation = "source-over";

    for (const i of this.dots.active) {
      const x = this.x(i);
      const y = this.y(i);
      const energy = this.dots.energy[i] ?? 0;
      if (energy > 0.01) {
        ctx.globalAlpha = Math.min(1, energy);
        ctx.fillStyle = css(color.alive);
        ctx.beginPath();
        ctx.arc(x, y, rest + (lit - rest) * energy, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = css(color.aliveCore);
        ctx.globalAlpha = Math.min(1, energy) * 0.9;
        ctx.beginPath();
        ctx.arc(x, y, (rest + (lit - rest) * energy) * 0.45, 0, 6.2832);
        ctx.fill();
      }
      // A request on its way: a ring closing in on the app.
      if (fleet.inFlight[i] && fleet.states[i] !== AWAKE) {
        const phase = still ? 0.5 : (now % 420) / 420;
        ctx.globalAlpha = 0.16 + 0.3 * phase;
        ctx.strokeStyle = css(color.line);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, cell * (0.4 - 0.22 * phase), 0, 6.2832);
        ctx.stroke();
      }
      // The answer: one ring going out, once.
      const ripple = this.dots.rippleAt[i] ?? 0;
      if (ripple) {
        const t = clamp01((now - ripple) / motion.rippleMs);
        ctx.globalAlpha = (1 - t) * 0.6;
        ctx.strokeStyle = css(color.alive);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, still ? cell * 0.5 : lit + cell * 0.85 * easeOut(t), 0, 6.2832);
        ctx.stroke();
      }
      const refused = this.dots.refusedAt[i] ?? 0;
      if (refused) {
        const t = clamp01((now - refused) / 900);
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.strokeStyle = css(color.refused);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.36, 0, 6.2832);
        ctx.stroke();
      }
    }

    // How long the newest cold starts took, where they happened.
    if (cell >= 13) {
      ctx.font = `500 ${Math.min(12, Math.max(10, cell * 0.42))}px "JetBrains Mono Variable", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = css(color.line);
      for (const tag of this.dots.tags) {
        const t = clamp01((now - tag.at) / 1400);
        ctx.globalAlpha = t < 0.15 ? t / 0.15 : 1 - easeOut((t - 0.15) / 0.85);
        ctx.fillText(tag.text, this.x(tag.i), this.y(tag.i) - cell * 0.62 - (still ? 0 : 8 * easeOut(t)));
      }
    }
    ctx.globalAlpha = 1;
    return moving;
  }
}
