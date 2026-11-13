/** Motion primitives shared by every scene: the clock's off switch, a spring, and easing. */
import { motion } from "./tokens";

const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let paused = false;
const listeners = new Set<() => void>();

/** True when movement must stop: the visitor asked the system for less motion, or pressed the page's pause. */
export const motionOff = (): boolean => paused || reducedQuery.matches;
export const motionPaused = (): boolean => paused;
export function setMotionPaused(next: boolean): void {
  paused = next;
  document.documentElement.toggleAttribute("data-motion-paused", next);
  for (const listener of listeners) listener();
}
export function onMotionChange(listener: () => void): () => void {
  listeners.add(listener);
  reducedQuery.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    reducedQuery.removeEventListener("change", listener);
  };
}

export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * One step of the `wake` spring toward 1, or of the plain `settle` toward 0. `value` and `velocity` live in
 * typed arrays owned by the caller, so a thousand dots cost no allocation per frame.
 */
export function stepEnergy(
  value: Float32Array,
  velocity: Float32Array,
  i: number,
  target: number,
  dt: number,
  instant: boolean,
): boolean {
  const current = value[i] ?? 0;
  if (instant) {
    value[i] = target;
    velocity[i] = 0;
    return false;
  }
  if (target > 0.5) {
    const v =
      (velocity[i] ?? 0) + (motion.wake.stiffness * (target - current) - motion.wake.damping * (velocity[i] ?? 0)) * dt;
    const next = current + v * dt;
    if (Math.abs(target - next) < 0.002 && Math.abs(v) < 0.02) {
      value[i] = target;
      velocity[i] = 0;
      return false;
    }
    value[i] = next;
    velocity[i] = v;
    return true;
  }
  velocity[i] = 0;
  if (current < 0.004) {
    value[i] = 0;
    return false;
  }
  value[i] = current * Math.exp(-dt / (motion.settleMs / 1000 / 3));
  return true;
}
