/**
 * The base of every canvas scene. It owns the things that make a canvas cheap: the backing store follows the
 * element's size at a capped pixel ratio, the loop runs only while the canvas is on screen and something is
 * still moving, and one switch (`motionOff`) stops movement for reduced motion and the page's pause button.
 *
 * A scene implements `layout()` (sizes changed) and `draw()` (one frame; return true while anything animates).
 * Call `invalidate()` when data changed and a frame is needed.
 */
import { motionOff, onMotionChange } from "./motion";

export abstract class Scene {
  protected readonly ctx: CanvasRenderingContext2D;
  protected width = 0;
  protected height = 0;
  protected dpr = 1;
  private frame = 0;
  private onScreen = false;
  private last = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(protected readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("this browser has no 2D canvas");
    this.ctx = ctx;
    const resize = new ResizeObserver(() => this.measure());
    resize.observe(canvas);
    const seen = new IntersectionObserver(
      (entries) => {
        this.onScreen = entries.some((entry) => entry.isIntersecting);
        this.invalidate();
      },
      { rootMargin: "80px" },
    );
    seen.observe(canvas);
    const visibility = () => this.invalidate();
    document.addEventListener("visibilitychange", visibility);
    this.cleanups.push(
      () => resize.disconnect(),
      () => seen.disconnect(),
      () => document.removeEventListener("visibilitychange", visibility),
      onMotionChange(() => this.invalidate()),
    );
  }

  /** Subclasses call this once their own fields exist. */
  protected ready(): void {
    this.measure();
  }

  protected own(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  private measure(): void {
    const box = this.canvas.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    // Past 2 the extra pixels cost fill rate on phones and cannot be seen on dots this small.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = box.width;
    this.height = box.height;
    this.canvas.width = Math.round(box.width * this.dpr);
    this.canvas.height = Math.round(box.height * this.dpr);
    this.layout();
    this.invalidate();
  }

  /** Ask for a frame. Cheap to call often: at most one is ever pending. */
  invalidate(): void {
    if (this.frame || !this.onScreen || document.hidden || this.width === 0) return;
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0;
      // After a pause the first step is one frame long, not the length of the pause.
      const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 1 / 60;
      this.last = now;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const moving = this.draw(now, dt, motionOff());
      if (moving) this.invalidate();
      else this.last = 0;
    });
  }

  protected abstract layout(): void;
  protected abstract draw(now: number, dt: number, still: boolean): boolean;

  destroy(): void {
    cancelAnimationFrame(this.frame);
    for (const cleanup of this.cleanups) cleanup();
  }
}

/**
 * A soft round light, drawn once and stamped per dot: far cheaper than a gradient or a shadow per dot per frame.
 * Give every stop the same colour at a different alpha; fading to the keyword `transparent` greys the edge.
 */
export function glowSprite(size: number, stops: readonly (readonly [number, string])[]): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = size;
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, colour] of stops) gradient.addColorStop(at, colour);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return sprite;
}
