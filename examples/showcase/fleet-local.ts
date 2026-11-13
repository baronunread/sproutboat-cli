/**
 * The local preview's fleet: real processes on this machine, started on a request and stopped when idle.
 *
 * On Sproutboat Cloud the Fleet section shows apps that sproutd starts and stops. A laptop has no sproutd, so
 * `serve.ts` runs this instead: N slots, each one a copy of fleet-app built as a standalone binary. A request to a
 * slot whose process is not running starts it (about 6 ms here), the answer is forwarded, and a process nobody
 * has called for IDLE_MS is stopped. Memory is the resident size of the running processes, read from `ps`.
 *
 * Nothing here is simulated, and nothing here is sproutd: no cgroups, no shared runtime, a whole binary per
 * process. The page says "local preview" wherever these numbers show.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import type { FleetSnapshot } from "./fleet-contract";

const HERE = import.meta.dir;
const APP_DIR = join(HERE, "fleet-app");
const BINARY = join(APP_DIR, "dist/showcase-fleet");
const CLI = join(HERE, "../../src/main.ts");

/** Hard limits. The page shows them; the storyboard in DESIGN.md is designed around them. */
export const FLEET_LIMITS = {
  /** Slots in the grid. */
  apps: Number(process.env.FLEET_APPS) || 400,
  /** Processes alive at once. A wake past this is refused with 503 `full`. */
  maxAwake: 120,
  /** A process with no request for this long is stopped. */
  idleMs: 6000,
  /** Per address: a bucket of `burst` wakes or requests, refilled at `perSecond`. */
  burst: 160,
  perSecond: 40,
  /** How long a starting process may take to answer before it is given up on. */
  startTimeoutMs: 3000,
};

/** How long the process took to answer the request that started it, and that answer. */
type Started = { ms: number; body: string };

/** Why a request was not served. The page shows a line for `full` and `rate_limited`. */
type Refusal = { error: string; code: "not_found" | "rate_limited" | "full" | "start_failed" | "gone" };

type Slot = {
  child: ReturnType<typeof Bun.spawn> | null;
  port: number;
  /** A start in progress: everyone who asks meanwhile waits for the same one. */
  starting: Promise<Started> | null;
  lastUsed: number;
  reaper: ReturnType<typeof setTimeout> | null;
};

/** Build the fleet app for this machine unless the binary is newer than its source. */
export async function ensureFleetBinary(): Promise<void> {
  const source = join(APP_DIR, "src/index.ts");
  if (existsSync(BINARY) && statSync(BINARY).mtimeMs > statSync(source).mtimeMs) return;
  console.log("  building the fleet app as a standalone binary (about 25 seconds, once)…");
  const built = Bun.spawn(["bun", CLI, "build", APP_DIR, "--standalone", "--target", "host"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await built.exited) !== 0) throw new Error("the fleet app did not build");
}

export function createLocalFleet(basePort: number, dataRoot: string) {
  const limits = FLEET_LIMITS;
  const slots: Slot[] = Array.from({ length: limits.apps }, (_, i) => ({
    child: null,
    port: basePort + i,
    starting: null,
    lastUsed: 0,
    reaper: null,
  }));
  let awake = 0;
  let usedKiB = 0;
  const buckets = new Map<string, { tokens: number; at: number }>();
  mkdirSync(dataRoot, { recursive: true });

  // #region supervisor
  // Start slot i's process and send it the request that woke it: the time is spawn to that first answer.
  // The same contract sproutd keeps on the Cloud: asleep until asked, one process per app.
  async function start(slot: Slot, i: number): Promise<Started> {
    const began = performance.now();
    const child = Bun.spawn([BINARY], {
      env: { PATH: process.env.PATH ?? "", PORT: String(slot.port), SB_DATA_DIR: join(dataRoot, String(i)) },
      stdout: "ignore",
      stderr: "pipe",
    });
    slot.child = child;
    awake++;
    void child.exited.then(() => {
      if (slot.child !== child) return;
      slot.child = null;
      awake--;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), limits.startTimeoutMs);
    try {
      // The binary prints one line (on stderr) when its socket is open. Waiting for that line is exact; polling the port
      // would add its own delay to the number.
      const { value } = await child.stderr.getReader().read();
      if (!value) throw new Error("the app exited before it listened");
      const body = await (await fetch(`http://127.0.0.1:${slot.port}/`)).text();
      return { ms: performance.now() - began, body };
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Stop a process nobody has called for idleMs. Its slot stays; the next request starts a new process.
  function touch(slot: Slot) {
    slot.lastUsed = Date.now();
    if (slot.reaper) clearTimeout(slot.reaper);
    slot.reaper = setTimeout(() => slot.child?.kill("SIGTERM"), limits.idleMs);
  }
  // #endregion

  function allowed(address: string): boolean {
    const now = performance.now();
    const bucket = buckets.get(address) ?? { tokens: limits.burst, at: now };
    bucket.tokens = Math.min(limits.burst, bucket.tokens + ((now - bucket.at) / 1000) * limits.perSecond);
    bucket.at = now;
    buckets.set(address, bucket);
    if (buckets.size > 2000) buckets.clear();
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }

  const reply = (body: FleetSnapshot | Refusal, status: number, retryAfter?: number) => {
    const headers = new Headers({ "cache-control": "no-store" });
    if (retryAfter) headers.set("retry-after", String(retryAfter));
    return Response.json(body, { status, headers });
  };

  /** GET /app/<i>: the app's own answer, starting it first if it is asleep. */
  async function request(i: number, address: string): Promise<Response> {
    const slot = slots[i];
    if (!slot) return reply({ error: "no such app", code: "not_found" }, 404);
    if (!allowed(address))
      return reply({ error: "slow down: too many requests from your address", code: "rate_limited" }, 429, 2);
    let started: Started | null = null;
    if (!slot.child) {
      if (!slot.starting) {
        if (awake >= limits.maxAwake)
          return reply({ error: `this preview runs at most ${limits.maxAwake} apps at once`, code: "full" }, 503, 3);
        const mine = (slot.starting = start(slot, i).finally(() => (slot.starting = null)));
        try {
          started = await mine;
        } catch {
          return reply({ error: "the app did not start", code: "start_failed" }, 502);
        }
      }
      try {
        if (!started) await slot.starting;
      } catch {
        return reply({ error: "the app did not start", code: "start_failed" }, 502);
      }
    }
    touch(slot);
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    // The caller whose request started the process gets that first answer, and how long the start took
    // (Server-Timing is the standard header for telling a browser what the server side cost).
    if (started) {
      headers.set("server-timing", `wake;dur=${started.ms.toFixed(1)}`);
      return new Response(started.body, { headers });
    }
    try {
      const upstream = await fetch(`http://127.0.0.1:${slot.port}/`);
      return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
    } catch {
      return reply({ error: "the app stopped while answering", code: "gone" }, 502);
    }
  }

  // Resident memory of the running processes, from the system. Sampled only while something runs.
  const sampler = setInterval(() => {
    const pids = slots.flatMap((slot) => (slot.child ? [slot.child.pid] : []));
    if (pids.length === 0) {
      usedKiB = 0;
      return;
    }
    const ps = Bun.spawn(["ps", "-o", "rss=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
    void new Response(ps.stdout).text().then((text) => {
      usedKiB = text
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0);
    });
  }, 400);

  function snapshot(): FleetSnapshot {
    let states = "";
    for (const slot of slots) states += slot.child ? (slot.starting ? "w" : "a") : "z";
    return {
      v: 1,
      mode: "local",
      label: `local preview: ${limits.apps} copies of one standalone binary on this machine, not sproutd`,
      at: Date.now(),
      apps: limits.apps,
      states,
      awake,
      memory: { usedKiB, hostKiB: Math.round(totalmem() / 1024), source: "sum of RSS from ps, every 400 ms" },
      limits: { maxAwake: limits.maxAwake, idleMs: limits.idleMs, perSecond: limits.perSecond },
      pollMs: 400,
    };
  }

  function stop() {
    clearInterval(sampler);
    for (const slot of slots) {
      if (slot.reaper) clearTimeout(slot.reaper);
      slot.child?.kill("SIGKILL");
    }
  }

  return { request, snapshot, stop, state: () => reply(snapshot(), 200) };
}
