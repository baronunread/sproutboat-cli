/**
 * What the Fleet section reads from its state URL. Two servers answer in this shape: `fleet-local.ts` in a local
 * preview, and the Cloud's public showcase endpoint once it exists (DESIGN.md, "Platform work").
 *
 * It carries one account only (the showcase fleet): a letter per app, two totals and the last few requests. No
 * visitor address, path, header or user agent is in it, and nothing about any other account.
 */
/** One request the fleet answered: enough to find your own (the id is in your response) and nothing about who sent it. */
export type FleetRequest = {
  /** The same value as the response header `x-sproutboat-request-id`. */
  id: string;
  /** The app's number. */
  i: number;
  /** When the platform answered (epoch ms). */
  at: number;
  /** True when this request started the process. */
  cold: boolean;
  /** How long the start took, for a cold request. */
  wakeMs: number | null;
};

/** What `<state URL>/<i>` answers: one app's process, as the host sees it. */
export type FleetAppFacts = {
  i: number;
  /** z asleep, w starting, a running. */
  state: string;
  pid: number | null;
  /** When the process started (epoch ms). */
  startedAt: number | null;
  /** Memory the process holds now. */
  memoryKiB: number | null;
  /** How `memoryKiB` was measured, in words. */
  source: string;
};

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
  /** The newest requests the fleet answered, oldest first, from every visitor and every terminal. */
  recent: FleetRequest[];
  limits: { maxAwake: number; idleMs: number; perSecond: number };
  /** How soon the page may ask again. */
  pollMs: number;
};
