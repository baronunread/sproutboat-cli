/**
 * The hero's stage: the same fleet seen from the waterline. Sleeping apps sit on the water, unlit. A running
 * app lifts off it and throws a reflection; an answered request spreads one ring on the surface. The swell is
 * the only thing here that is not data, which is why every dot shares it: it reads as water, not as activity.
 */
import { clamp01, easeOut } from "../system/motion";
import { glowSprite, Scene } from "../system/scene";
import { color, css, motion } from "../system/tokens";
import { Dots } from "./dots";
import { fleet } from "./store";

export class SeaScene extends Scene {
  private readonly dots = new Dots(() => this.invalidate());
  private readonly glow = glowSprite(128, [
    // Quieter than the grid's: in a wave these overlap several deep, and light adds up.
    [0, css(color.alive, 0.4)],
    [0.28, css(color.alive, 0.09)],
    [1, css(color.alive, 0)],
  ]);
  private cols = 1;
  private rows = 1;
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private scale = new Float32Array(0);
  private readonly haze = glowSprite(256, [
    [0, css(color.line, 0.085)],
    [1, css(color.line, 0)],
  ]);
  private horizon = 0;
  private spacing = 10;
  private drawn = -1;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    this.own(this.dots.connect());
    this.own(fleet.subscribe(() => fleet.apps !== this.drawn && (this.layout(), this.invalidate())));
    this.ready();
  }

  protected layout(): void {
    const n = fleet.apps;
    this.drawn = n;
    this.horizon = Math.round(this.height * 0.13);
    if (n === 0) return;
    // A wide, shallow field: about four times as many columns as rows on a desktop, squarer on a phone.
    const aspect = this.width > 720 ? 4.4 : 1.25;
    this.rows = Math.max(1, Math.round(Math.sqrt(n / aspect)));
    this.cols = Math.ceil(n / this.rows);
    this.spacing = (this.width * 0.94) / this.cols;
    // The bottom of the canvas sits under the hero's source line, so the field stops short of it.
    const depth = Math.min(this.height - this.horizon - 112, this.rows * this.spacing * 0.8);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.scale = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const col = i % this.cols;
      const row = Math.floor(i / this.cols);
      const near = this.rows === 1 ? 1 : row / (this.rows - 1);
      // Far rows are smaller and closer together, as on a surface seen from just above it.
      const k = 0.58 + 0.42 * near;
      this.scale[i] = k;
      this.px[i] = this.width / 2 + (col - (this.cols - 1) / 2) * this.spacing * k;
      this.py[i] = this.horizon + 16 + depth * near ** 1.35;
    }
  }

  /** Columns and rows from the middle of the field, for a wave that starts there. */
  distanceFromCentre = (i: number): number =>
    Math.hypot((i % this.cols) - (this.cols - 1) / 2, (Math.floor(i / this.cols) - (this.rows - 1) / 2) * 2.4);

  protected draw(now: number, dt: number, still: boolean): boolean {
    const { ctx } = this;
    const moving = this.dots.step(now, dt, still);
    ctx.clearRect(0, 0, this.width, this.height);

    // The waterline: one hairline, brightest in the middle.
    const line = ctx.createLinearGradient(0, 0, this.width, 0);
    line.addColorStop(0, css(color.line, 0));
    line.addColorStop(0.5, css(color.line, 0.26));
    line.addColorStop(1, css(color.line, 0));
    ctx.fillStyle = line;
    ctx.fillRect(0, this.horizon, this.width, 1);
    // A little light on the water under it, so the field has somewhere to recede to.
    ctx.drawImage(this.haze, -this.width * 0.1, this.horizon - this.height * 0.3, this.width * 1.2, this.height * 0.6);
    ctx.clearRect(0, 0, this.width, this.horizon);
    ctx.fillRect(0, this.horizon, this.width, 1);

    const n = fleet.apps;
    if (n === 0) return false;
    const time = still ? 0 : now / 1000;
    const rest = Math.max(1.1, this.spacing * 0.085);
    const lift = Math.min(30, this.spacing * 1.1);

    ctx.fillStyle = css(color.asleep);
    for (let i = 0; i < n; i++) {
      const k = this.scale[i] ?? 1;
      const swell = Math.sin(time * 0.7 + (i % this.cols) * 0.42 + Math.floor(i / this.cols) * 0.9) * 1.4 * k;
      ctx.globalAlpha = 0.24 + (0.56 * (k - 0.58)) / 0.42;
      ctx.beginPath();
      ctx.arc(this.px[i] ?? 0, (this.py[i] ?? 0) + swell, rest * k, 0, 6.2832);
      ctx.fill();
    }

    for (const i of this.dots.active) {
      const k = this.scale[i] ?? 1;
      const x = this.px[i] ?? 0;
      const swell = Math.sin(time * 0.7 + (i % this.cols) * 0.42 + Math.floor(i / this.cols) * 0.9) * 1.4 * k;
      const water = (this.py[i] ?? 0) + swell;
      const energy = this.dots.energy[i] ?? 0;
      const shown = Math.min(1, energy);

      const ripple = this.dots.rippleAt[i] ?? 0;
      if (ripple) {
        const t = clamp01((now - ripple) / motion.rippleMs);
        const radius = still ? this.spacing * k : this.spacing * k * (0.3 + 1.9 * easeOut(t));
        ctx.globalAlpha = (1 - t) * 0.6;
        ctx.strokeStyle = css(color.alive);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, water, radius, radius * 0.3, 0, 0, 6.2832);
        ctx.stroke();
      }
      if (energy <= 0.01) continue;
      const y = water - lift * k * energy;
      const size = this.spacing * 4.2 * k;
      ctx.globalCompositeOperation = "lighter";
      // The light itself, and its reflection lying on the water under it.
      ctx.globalAlpha = shown * 0.95;
      ctx.drawImage(this.glow, x - size / 2, y - size / 2, size, size);
      ctx.globalAlpha = shown * 0.5;
      ctx.drawImage(this.glow, x - size * 0.17, water - size * 0.08, size * 0.34, size * 0.56);
      ctx.globalCompositeOperation = "source-over";
      // What holds it up.
      ctx.globalAlpha = shown * 0.35;
      ctx.fillStyle = css(color.alive);
      ctx.fillRect(x - 0.5, y, 1, water - y);
      ctx.globalAlpha = shown;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.8, this.spacing * 0.13) * k * (0.6 + 0.4 * energy), 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = css(color.aliveCore);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.9, this.spacing * 0.06) * k, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = css(color.asleep);
    }
    ctx.globalAlpha = 1;
    // The swell never ends, so the loop runs whenever the hero is on screen and motion is allowed.
    return moving || !still;
  }
}
