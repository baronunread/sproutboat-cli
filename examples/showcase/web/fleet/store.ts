/**
 * The fleet's state, as the page knows it. One store feeds the hero and the Fleet section.
 *
 * Two inputs, both real:
 *   - a snapshot polled from the state URL (which apps are running, and the memory they hold);
 *   - the page's own requests to single apps, timed in the visitor's browser.
 * Scenes never invent a transition: a dot lights when a snapshot or an answer says its app is running, and
 * dims when a snapshot says it stopped.
 */
import type { FleetAppFacts, FleetRequest, FleetSnapshot } from "../../fleet-contract";
import type { Feed, FeedStatus } from "../system/feed";

export const ASLEEP = 0;
export const STARTING = 1;
export const AWAKE = 2;

export type FleetEvent =
  /** The page sent a request to app i. */
  | { type: "request"; i: number }
  /** App i answered. `ms` is the round trip in this browser; `wakeMs` the server-side start, when reported. */
  | { type: "answer"; i: number; ms: number; wakeMs: number | null; cold: boolean; source: Source }
  /** The platform refused the request (a rate limit or a cap). */
  | { type: "refused"; i: number; code: string }
  /** A snapshot says app i changed state without this page asking: another visitor, or the idle timer. */
  | { type: "changed"; i: number; to: number }
  /** A snapshot arrived. */
  | { type: "sample" };

export type Source = "visit" | "sweep" | "wave";

type Info = { edition: string; fleet: { stateUrl: string; appUrl: string } | null };

/** The last answer this page got from one app, kept as it arrived: what the inspector prints. */
export type Receipt = {
  i: number;
  /** When it arrived (epoch ms). */
  at: number;
  status: number;
  /** Round trip in this browser. */
  ms: number;
  /** The headers the platform added, in the order it sent them. */
  headers: [name: string, value: string][];
  body: string;
};

/** The response headers that say which process answered. A browser shows a page only the ones the server exposes. */
const RECEIPT_HEADERS = ["server-timing", "x-sproutboat-pid", "x-sproutboat-started", "x-sproutboat-request-id"];

/** The page's own budget, kept under the server's so a sweep degrades by skipping, not by being refused. */
const BUDGET = { burst: 70, perSecond: 30 };

class FleetStore implements Feed {
  status: FeedStatus = "connecting";
  snapshot: FleetSnapshot | null = null;
  states = new Uint8Array(0);
  inFlight = new Uint8Array(0);
  /** Memory samples (KiB) for the sparkline: the last minute or so. */
  readonly memory: number[] = [];
  lastAnswer: Extract<FleetEvent, { type: "answer" }> | null = null;
  /** The platform's last refusal, for the line that explains it. */
  lastRefused: { code: string; at: number } | null = null;
  info: Info | null = null;
  /** The app the inspector shows, -1 before the first one is picked. */
  selected = -1;
  /** The selected app's process, as the host reports it. */
  facts: FleetAppFacts | null = null;
  readonly receipts = new Map<number, Receipt>();
  /** Ids of the requests this page sent, to mark them in the tail. */
  readonly mine = new Set<string>();

  private factsAt = 0;
  private readonly eventListeners = new Set<(event: FleetEvent) => void>();
  private readonly changeListeners = new Set<() => void>();
  private lastRequestAt = new Float64Array(0);
  private lastSampleAt = 0;
  private tokens = BUDGET.burst;
  private tokensAt = performance.now();
  private started = false;
  private watchers = 0;

  /** Every event, for scenes. */
  on(listener: (event: FleetEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  /** "Something a readout shows may have changed", for the DOM. */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  private emit(event: FleetEvent): void {
    for (const listener of this.eventListeners) listener(event);
    for (const listener of this.changeListeners) listener();
  }

  get label(): string {
    return this.snapshot?.label ?? "";
  }
  onSample(listener: () => void): () => void {
    return this.on((event) => event.type === "sample" && listener());
  }

  get apps(): number {
    return this.snapshot?.apps ?? 0;
  }
  get recent(): readonly FleetRequest[] {
    return this.snapshot?.recent ?? [];
  }

  /** App i's own address: the thing to open in a tab or hand to curl. */
  appUrl(i: number): string {
    const pattern = this.info?.fleet?.appUrl;
    return pattern ? new URL(pattern.replace("{i}", String(i)), location.href).href : "";
  }
  /** The feed this page polls, for anyone who would rather read it raw. */
  get stateUrl(): string {
    const url = this.info?.fleet?.stateUrl;
    return url ? new URL(url, location.href).href : "";
  }

  /** Pick the app the inspector shows. */
  select(i: number): void {
    if (i < 0 || i >= this.apps || i === this.selected) return;
    this.selected = i;
    this.facts = null;
    this.factsAt = 0;
    void this.readFacts();
    this.emit({ type: "sample" });
  }

  /** The selected app's process facts, at most about once a second, and not at all while it is known to be asleep. */
  private async readFacts(): Promise<void> {
    const i = this.selected;
    const fleet = this.info?.fleet;
    if (!fleet || i < 0) return;
    const now = performance.now();
    if (now - this.factsAt < 900) return;
    if (this.facts?.i === i && this.facts.state === "z" && this.states[i] === ASLEEP) return;
    this.factsAt = now;
    try {
      const response = await fetch(`${fleet.stateUrl}/${i}`, { cache: "no-store" });
      if (!response.ok || this.selected !== i) return;
      this.facts = await response.json();
      for (const listener of this.changeListeners) listener();
    } catch {}
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // The Worker may still be compiling in a local preview: ask until it answers.
    for (let attempt = 0; attempt < 120 && !this.info; attempt++) {
      try {
        const response = await fetch("api/info", { cache: "no-store" });
        if (response.ok) this.info = await response.json();
        else if (response.status !== 503) break;
      } catch {}
      if (!this.info) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!this.info?.fleet) {
      this.status = "offline";
      this.emit({ type: "sample" });
      return;
    }
    document.addEventListener("visibilitychange", () => void this.poll());
    setInterval(() => {
      if (this.status === "live" && performance.now() - this.lastSampleAt > 4000) {
        this.status = "stale";
        this.emit({ type: "sample" });
      }
    }, 1000);
    void this.poll();
  }

  private polling = false;
  private async poll(): Promise<void> {
    if (this.polling || document.hidden || !this.info?.fleet) return;
    this.polling = true;
    while (!document.hidden) {
      let wait = 1000;
      try {
        const response = await fetch(this.info.fleet.stateUrl, { cache: "no-store" });
        if (response.ok) {
          const snapshot: FleetSnapshot = await response.json();
          this.apply(snapshot);
          wait = snapshot.pollMs;
        }
      } catch {}
      // Nothing running and nobody looking: a slow heartbeat is enough.
      if (this.watchers === 0) wait = Math.max(wait, 2000);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.polling = false;
  }

  /** A scene on screen asks for the fast poll; it gives it back when it leaves. */
  watch(): () => void {
    this.watchers++;
    return () => void this.watchers--;
  }

  private apply(snapshot: FleetSnapshot): void {
    if (this.states.length !== snapshot.apps) {
      this.states = new Uint8Array(snapshot.apps);
      this.inFlight = new Uint8Array(snapshot.apps);
      this.lastRequestAt = new Float64Array(snapshot.apps);
    }
    this.snapshot = snapshot;
    this.status = "live";
    this.lastSampleAt = performance.now();
    this.memory.push(snapshot.memory.usedKiB);
    if (this.memory.length > 150) this.memory.shift();
    for (let i = 0; i < snapshot.apps; i++) {
      const letter = snapshot.states.charCodeAt(i);
      const next = letter === 97 ? AWAKE : letter === 119 ? STARTING : ASLEEP;
      if (next === this.states[i]) continue;
      // An answer this page already received is newer than a snapshot taken before it.
      if (next === ASLEEP && performance.now() - (this.lastRequestAt[i] ?? 0) < 600) continue;
      this.states[i] = next;
      this.emit({ type: "changed", i, to: next });
    }
    void this.readFacts();
    this.emit({ type: "sample" });
  }

  private spend(): boolean {
    const now = performance.now();
    this.tokens = Math.min(BUDGET.burst, this.tokens + ((now - this.tokensAt) / 1000) * BUDGET.perSecond);
    this.tokensAt = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  // #region wake
  // One request to one app, timed where the visitor is. If the app was asleep, this request is what starts it:
  // the page never tells the platform to "wake" anything, it just asks the app a question.
  async request(i: number, source: Source): Promise<void> {
    const fleet = this.info?.fleet;
    if (!fleet || i < 0 || i >= this.apps || this.inFlight[i]) return;
    const now = performance.now();
    // A running app is asked again at most about once a second, however fast the pointer moves over it.
    if (this.states[i] === AWAKE && now - (this.lastRequestAt[i] ?? 0) < 900) return;
    if (!this.spend()) return;
    this.inFlight[i] = 1;
    this.lastRequestAt[i] = now;
    this.emit({ type: "request", i });
    try {
      const response = await fetch(fleet.appUrl.replace("{i}", String(i)), { cache: "no-store" });
      const ms = performance.now() - now;
      if (!response.ok) {
        const body: { code?: string } = await response.json().catch(() => ({}));
        this.lastRefused = { code: body.code ?? String(response.status), at: performance.now() };
        this.emit({ type: "refused", i, code: this.lastRefused.code });
        return;
      }
      const text = await response.text();
      const body: { cold: boolean } = JSON.parse(text);
      const timing = /wake;dur=([\d.]+)/.exec(response.headers.get("server-timing") ?? "");
      // Keep the answer as it arrived: the inspector prints it beside the curl line that would fetch it again.
      const headers: Receipt["headers"] = [];
      for (const name of RECEIPT_HEADERS) {
        const value = response.headers.get(name);
        if (value) headers.push([name, value]);
      }
      this.receipts.set(i, { i, at: Date.now(), status: response.status, ms, headers, body: text.slice(0, 240) });
      const id = response.headers.get("x-sproutboat-request-id");
      if (id) this.mine.add(id);
      if (this.mine.size > 400) this.mine.clear();
      this.factsAt = 0;
      this.states[i] = AWAKE;
      this.lastRequestAt[i] = performance.now();
      const answer = {
        type: "answer",
        i,
        ms,
        wakeMs: timing ? Number(timing[1]) : null,
        cold: body.cold,
        source,
      } as const;
      if (body.cold || !this.lastAnswer) this.lastAnswer = answer;
      this.emit(answer);
    } catch {
      this.emit({ type: "refused", i, code: "network" });
    } finally {
      this.inFlight[i] = 0;
    }
  }
  // #endregion

  /** A wave: `count` sleeping apps nearest to `origin` (by `distance`), asked one after another, nearest first. */
  wave(count: number, distance: (i: number) => number): void {
    const asleep: number[] = [];
    for (let i = 0; i < this.apps; i++) if (this.states[i] === ASLEEP && !this.inFlight[i]) asleep.push(i);
    asleep.sort((a, b) => distance(a) - distance(b));
    asleep.slice(0, count).forEach((i, order) => setTimeout(() => void this.request(i, "wave"), order * 22));
  }
}

export const fleet = new FleetStore();
