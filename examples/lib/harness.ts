/**
 * Lifecycle for the native conformance harnesses (#276).
 *
 * The kitchen-sink harnesses and the small-example smoke runner drive a native
 * child over HTTP. Without a deadline, a child that accepts a connection and
 * never finishes the response leaves the run waiting forever, and an
 * interrupted run leaves the child and its temp dir behind. This module gives
 * them one shared answer:
 *
 * - every HTTP and raw-socket operation has a deadline (`SB_HARNESS_REQUEST_TIMEOUT_MS`);
 * - the current step is recorded before it starts, so a stall names it;
 * - readiness (`SB_HARNESS_READY_TIMEOUT_MS`) and compilation
 *   (`SB_HARNESS_BUILD_TIMEOUT_MS`) have their own deadlines, so a slow build
 *   cannot look like a hung handler;
 * - a failure prints the step, backend, versions and the child's recent stderr
 *   with declared secret values removed;
 * - cleanup stops only this process's own children and removes only its own
 *   temp dir, on failure, on SIGINT and on SIGTERM.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_READY_TIMEOUT_MS = 20_000;
export const DEFAULT_BUILD_TIMEOUT_MS = 900_000;
const STDERR_TAIL_BYTES = 8 * 1024;

/** A positive integer number of milliseconds from the environment, or `fallback`. */
export function readDeadline(name: string, fallback: number, env: Record<string, string | undefined> = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer (milliseconds), got "${raw}"`);
  return value;
}

export type FailureKind = "request-timeout" | "ready-timeout" | "build-timeout" | "child-exited" | "failed";

export class HarnessFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly step: string,
  ) {
    super(message);
    this.name = "HarnessFailure";
  }
}

/** What a failure can be: a harness failure, another Error, or a plain message. */
export type HarnessError = Error | string;

export type HarnessOptions = {
  /** "broker", "standalone", "smoke:<example>": named in every failure report. */
  backend: string;
  /** Secret values that may appear in child output; removed from reports. */
  secrets?: string[];
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  buildTimeoutMs?: number;
  /** Prefix for the temp dir. */
  prefix?: string;
  /** Install SIGINT and SIGTERM handlers. Default true. */
  handleSignals?: boolean;
  /** Print each step as it starts. Default: when stderr is a terminal or SB_HARNESS_VERBOSE=1. */
  announceSteps?: boolean;
};

type Watched = { name: string; child: ReturnType<typeof Bun.spawn>; tail: () => string };

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

function packageVersion(path: string): string {
  try {
    return String(JSON.parse(readFileSync(path, "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

export function versionSummary() {
  const root = join(import.meta.dir, "../..");
  const dep = (name: string) => packageVersion(join(root, "node_modules/@sproutboat", name, "package.json"));
  return {
    cli: packageVersion(join(root, "package.json")),
    runtime: dep("runtime"),
    toolchain: dep("toolchain"),
    wire: dep("wire"),
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

/** Direct and indirect children of this process, from one `ps` snapshot. */
export function descendantPids(root = process.pid): number[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  if (ps.exitCode !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.toString().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()!) ?? []) {
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

export class Harness {
  readonly backend: string;
  readonly workdir: string;
  readonly requestTimeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly buildTimeoutMs: number;
  private currentStep = "starting";
  private readonly secrets: string[];
  private readonly watched: Watched[] = [];
  private readonly announce: boolean;
  private cleaned = false;
  private readonly onSignal: Array<[NodeJS.Signals, () => void]> = [];

  constructor(options: HarnessOptions) {
    this.backend = options.backend;
    this.secrets = (options.secrets ?? []).filter((value) => value.length > 0);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? readDeadline("SB_HARNESS_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
    this.readyTimeoutMs =
      options.readyTimeoutMs ?? readDeadline("SB_HARNESS_READY_TIMEOUT_MS", DEFAULT_READY_TIMEOUT_MS);
    this.buildTimeoutMs =
      options.buildTimeoutMs ?? readDeadline("SB_HARNESS_BUILD_TIMEOUT_MS", DEFAULT_BUILD_TIMEOUT_MS);
    this.announce = options.announceSteps ?? (process.stderr.isTTY === true || process.env.SB_HARNESS_VERBOSE === "1");
    this.workdir = mkdtempSync(join(tmpdir(), options.prefix ?? "sb-harness-"));
    if (options.handleSignals !== false) {
      for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        const handler = () => {
          console.error(`\ninterrupted (${signal}) during step: ${this.currentStep}`);
          this.cleanupSync();
          process.exit(code);
        };
        process.on(signal, handler);
        this.onSignal.push([signal, handler]);
      }
    }
  }

  /** Record the step before starting it, so a stall names what it was doing. */
  step(name: string): void {
    this.currentStep = name;
    if (this.announce) console.error(`  .. ${name}`);
  }

  get stepName(): string {
    return this.currentStep;
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
    return out;
  }

  /** Start a child this harness owns. Its stderr tail is kept for failure reports. */
  spawn(
    name: string,
    command: string[],
    options: {
      env?: Record<string, string | undefined>;
      cwd?: string;
      stdout?: "pipe" | "inherit" | "ignore";
      /** Also write the child's stderr to this process's stderr as it arrives. */
      tee?: boolean;
    } = {},
  ): ReturnType<typeof Bun.spawn> {
    const child = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: options.stdout ?? "ignore",
      stderr: "pipe",
    });
    let tail = "";
    // Drained as it arrives: an undrained pipe blocks a chatty server.
    const drain = (async () => {
      const decoder = new TextDecoder();
      try {
        // SAFETY: spawn() above always sets stderr to "pipe", so child.stderr is a ReadableStream.
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
          if (options.tee) process.stderr.write(chunk);
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
        }
      } catch {}
    })();
    void drain;
    this.watched.push({ name, child, tail: () => tail });
    return child;
  }

  /** The recent stderr of every child, with declared secrets removed. */
  recentStderr(): string {
    return this.watched
      .map(({ name, tail }) => {
        const text = this.redact(tail()).trimEnd();
        return text ? `--- ${name} stderr (last ${STDERR_TAIL_BYTES} bytes at most) ---\n${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Resolves with a failure when any watched child exits, so a wait never outlives its child. */
  private childExit() {
    let cancelled = false;
    const promise = new Promise<never>((_, reject) => {
      for (const { name, child } of this.watched) {
        void child.exited.then((code) => {
          if (cancelled) return;
          reject(
            new HarnessFailure(
              "child-exited",
              `${name} exited with code ${code} during step "${this.currentStep}"`,
              this.currentStep,
            ),
          );
        });
      }
    });
    promise.catch(() => {});
    return { promise, cancel: () => (cancelled = true) };
  }

  /**
   * Run `work` under a deadline. `work` gets an AbortSignal that fires at the
   * deadline; the race also ends when a watched child exits.
   */
  async bounded<T>(
    kind: "request-timeout" | "ready-timeout" | "build-timeout",
    label: string,
    timeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>,
    options: { watchChildren?: boolean } = {},
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new HarnessFailure(
            kind,
            `${label} did not finish within ${timeoutMs} ms during step "${this.currentStep}"`,
            this.currentStep,
          ),
        );
        controller.abort();
      }, timeoutMs);
    });
    timedOut.catch(() => {});
    const exit = options.watchChildren === false ? undefined : this.childExit();
    try {
      let job = work(controller.signal);
      if (exit) {
        // A child that dies mid-request can break the connection before its exit
        // is observed: give the exit a moment to arrive, so the failure names the
        // child (with its stderr) instead of a bare connection error.
        job = job.catch(async (error) => {
          const grace = new Promise<never>((_, reject) => setTimeout(() => reject(error), 1000));
          grace.catch(() => {});
          return Promise.race([exit.promise, grace]);
        });
      }
      job.catch(() => {});
      return await Promise.race([job, timedOut, ...(exit ? [exit.promise] : [])]);
    } finally {
      clearTimeout(timer);
      exit?.cancel();
    }
  }

  /**
   * `fetch` with a deadline over the whole exchange, body included: the
   * response is read to the end before it is returned, so a server that sends
   * headers and never completes the body fails here, not in the caller.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return this.bounded(
      "request-timeout",
      `${init.method ?? "GET"} ${new URL(url).pathname}`,
      this.requestTimeoutMs,
      async (signal) => {
        const response = await globalThis.fetch(url, {
          ...init,
          signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
        });
        const bytes = await response.arrayBuffer();
        return new Response(NO_BODY_STATUS.has(response.status) ? null : bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    );
  }

  /** One raw TCP exchange: write `request`, read until the peer closes. Deadline applies. */
  async rawExchange(host: string, port: number, request: string): Promise<{ reply: string; closed: boolean }> {
    return this.bounded("request-timeout", `raw socket ${host}:${port}`, this.requestTimeoutMs, (signal) => {
      return new Promise((resolve, reject) => {
        let reply = "";
        const decoder = new TextDecoder();
        let socketHandle: { end(): void } | undefined;
        signal.addEventListener("abort", () => {
          socketHandle?.end();
          reject(new Error("aborted"));
        });
        Bun.connect({
          hostname: host,
          port,
          socket: {
            open(socket) {
              socketHandle = socket;
              socket.write(request);
            },
            data(_socket, chunk) {
              reply += decoder.decode(chunk, { stream: true });
            },
            close() {
              resolve({ reply, closed: true });
            },
            error(_socket, error) {
              reject(error);
            },
          },
        }).catch(reject);
      });
    });
  }

  /** Wait for `url` to answer, bounded separately from the build and from later requests. */
  async waitReady(url: string): Promise<void> {
    this.step(`waiting for ${new URL(url).host} to listen`);
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const exited = this.watched.find(({ child }) => child.exitCode !== null);
      if (exited) {
        throw new HarnessFailure(
          "child-exited",
          `${exited.name} exited with code ${exited.child.exitCode} before it listened`,
          this.currentStep,
        );
      }
      try {
        await globalThis.fetch(url, {
          signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))),
        });
        return;
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new HarnessFailure(
      "ready-timeout",
      `${this.backend} never listened within ${this.readyTimeoutMs} ms`,
      this.currentStep,
    );
  }

  /** Bound a build or compile step separately from readiness and requests. */
  async build<T>(label: string, work: () => Promise<T>): Promise<T> {
    this.step(label);
    return this.bounded("build-timeout", label, this.buildTimeoutMs, () => work(), { watchChildren: false });
  }

  /** The text printed for a failure: step, backend, versions and recent child stderr. */
  report(error: HarnessError): string {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof HarnessFailure ? error.kind : "failed";
    const versions = Object.entries(versionSummary())
      .map(([name, version]) => `${name} ${version}`)
      .join(", ");
    const lines = [
      `FAIL: ${this.redact(message)}`,
      `  step:     ${this.redact(error instanceof HarnessFailure ? error.step : this.currentStep)}`,
      `  kind:     ${kind}`,
      `  backend:  ${this.backend}`,
      `  versions: ${versions}`,
    ];
    const stderr = this.recentStderr();
    if (stderr) lines.push(stderr);
    return lines.join("\n");
  }

  private stopChildren(): void {
    for (const { child } of this.watched) {
      try {
        if (child.exitCode === null) child.kill(9);
      } catch {}
    }
  }

  /**
   * Stop this process's own children (the spawned ones and anything they or a
   * build started, found by parent pid, never by name) and remove the temp dir.
   */
  cleanupSync(options: { descendants?: boolean } = {}): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.stopChildren();
    if (options.descendants !== false) {
      for (const pid of descendantPids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    rmSync(this.workdir, { recursive: true, force: true });
    for (const [signal, handler] of this.onSignal) process.off(signal, handler);
  }

  /** Wait for the children to be gone, then clean up. */
  async cleanup(options: { descendants?: boolean } = {}): Promise<void> {
    this.stopChildren();
    await Promise.all(this.watched.map(({ child }) => child.exited));
    this.cleanupSync(options);
  }
}
