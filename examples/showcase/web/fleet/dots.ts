/**
 * What every fleet scene animates, per app: how lit it is, and the marks left by requests. The hero and the
 * grid draw these differently but they move by the same rules, from the same events.
 */
import { stepEnergy } from "../system/motion";
import { motion } from "../system/tokens";
import { AWAKE, fleet, type FleetEvent } from "./store";

export class Dots {
  /** 0 asleep … 1 running. Overshoots 1 once on a wake. */
  energy = new Float32Array(0);
  private velocity = new Float32Array(0);
  /** When the last answered request's ring started (ms), 0 for none. */
  rippleAt = new Float64Array(0);
  /** When the platform last refused a request to this app. */
  refusedAt = new Float64Array(0);
  /** A start time and a label ("6 ms") for the few most recent cold starts. */
  readonly tags: { i: number; at: number; text: string }[] = [];
  /** Indices that need drawing as more than a resting dot this frame. */
  readonly active: number[] = [];

  /**
   * `changed` asks the scene for a frame. `apart` says whether two apps are drawn far enough from each other
   * for both to carry a label; a scene that draws no labels leaves it out.
   */
  constructor(
    private readonly changed: () => void,
    private readonly apart: (a: number, b: number) => boolean = () => false,
  ) {}

  connect(): () => void {
    return fleet.on((event) => this.handle(event));
  }

  private fit(): void {
    const n = fleet.apps;
    if (this.energy.length === n) return;
    this.energy = new Float32Array(n);
    this.velocity = new Float32Array(n);
    this.rippleAt = new Float64Array(n);
    this.refusedAt = new Float64Array(n);
    // Apps already running when the page opens are simply lit: nothing happened that the visitor saw.
    for (let i = 0; i < n; i++) if (fleet.states[i] === AWAKE) this.energy[i] = 1;
  }

  private handle(event: FleetEvent): void {
    this.fit();
    const now = performance.now();
    if (event.type === "answer") {
      this.rippleAt[event.i] = now;
      // A label only where there is room for one: a wave is forty starts, and forty labels would be noise.
      if (event.cold && this.tags.every((tag) => this.apart(tag.i, event.i))) {
        const ms = event.wakeMs ?? event.ms;
        this.tags.push({ i: event.i, at: now, text: `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` });
      }
    } else if (event.type === "refused") this.refusedAt[event.i] = now;
    this.changed();
  }

  /** Advance every dot. Returns true while anything is still moving. */
  step(now: number, dt: number, still: boolean): boolean {
    this.fit();
    this.active.length = 0;
    let moving = false;
    const n = this.energy.length;
    for (let i = 0; i < n; i++) {
      const target = fleet.states[i] === AWAKE ? 1 : 0;
      const energy = this.energy[i] ?? 0;
      let busy = false;
      if (energy !== target) busy = stepEnergy(this.energy, this.velocity, i, target, dt, still);
      const ripple = this.rippleAt[i] ?? 0;
      if (ripple) {
        if (now - ripple > motion.rippleMs) this.rippleAt[i] = 0;
        else busy = true;
      }
      const refused = this.refusedAt[i] ?? 0;
      if (refused) {
        if (now - refused > 900) this.refusedAt[i] = 0;
        else busy = true;
      }
      if (fleet.inFlight[i]) busy = true;
      if (busy) moving = true;
      if (busy || (this.energy[i] ?? 0) > 0) this.active.push(i);
    }
    while (this.tags[0] && now - this.tags[0].at > 1400) this.tags.shift();
    if (this.tags.length) moving = true;
    return moving;
  }
}
