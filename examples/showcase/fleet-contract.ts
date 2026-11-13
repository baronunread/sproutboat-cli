/**
 * What the Fleet section reads from its state URL. Two servers answer in this shape: `fleet-local.ts` in a local
 * preview, and the Cloud's public showcase endpoint once it exists (DESIGN.md, "Platform work").
 *
 * It carries no names, ids, addresses or per-app numbers: one letter per app, two totals.
 */
export type FleetSnapshot = {
  v: 1;
  mode: "local" | "cloud";
  /** Shown next to every number that comes from this feed. */
  label: string;
  /** When the server took the sample (epoch ms). */
  at: number;
  apps: number;
  /** One character per app, in a fixed order: z asleep, w starting, a running. */
  states: string;
  awake: number;
  memory: {
    /** Memory held by the fleet's running processes. */
    usedKiB: number;
    hostKiB: number;
    /** How `usedKiB` was measured, in words. */
    source: string;
  };
  limits: { maxAwake: number; idleMs: number; perSecond: number };
  /** How soon the page may ask again. */
  pollMs: number;
};
