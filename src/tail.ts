/**
 * `sproutboat tail`: stream one app's live events from the control plane
 * (`GET /api/projects/<name>/tail`, Server-Sent Events) the way `wrangler tail`
 * does. Request events come from the edge log; console output and uncaught
 * exceptions come from the sprout's own output and arrive as their own events,
 * never attached to a request (the runtime does not tag a console line with a
 * request id). The server enforces the filters, a per-second event cap and a
 * ten minute connection cap; this side reconnects when that cap closes the stream.
 */
import { isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";
import { amber, bold, dim, leaf, rose } from "./style";

export type TailFormat = "pretty" | "json";

export type TailArgs = {
  dir: string | undefined;
  format: TailFormat;
  recent: boolean;
  sprout: boolean;
  status: string[];
  method: string[];
  samplingRate: string | undefined;
  search: string | undefined;
  outcome: string[];
};

export type TailLog = { level: string; message: JsonValue[]; timestamp: number };
export type TailException = { name: string; message: string; timestamp: number; stack?: string };
export type TailEvent = {
  scriptName: string;
  outcome: string;
  eventTimestamp: number;
  event: {
    request: { url: string; method: string; headers?: Record<string, string> };
    response: { status: number };
  } | null;
  cpuTime: number | null;
  wallTime: number;
  logs: TailLog[];
  exceptions: TailException[];
};

export type TailFrame =
  | { type: "ready" }
  | { type: "event"; event: TailEvent }
  | { type: "dropped"; count: number; bytes?: number; reason: string }
  | { type: "closed"; reason: string };

export const TAIL_USAGE =
  "tail [project-dir] [--format pretty|json] [--status ok|error|<code>|5xx] [--method GET,POST] [--sampling-rate 0.1] [--search <text>] [--outcome <name>] | tail --recent | tail --sprout";

const VALUE_FLAGS = ["--format", "--status", "--method", "--sampling-rate", "--search", "--outcome"] as const;

/** Parse `tail` arguments; `error` is a usage error message. */
export function parseTailArgs(args: string[]): { args: TailArgs } | { error: string } {
  const parsed: TailArgs = {
    dir: undefined,
    format: "pretty",
    recent: false,
    sprout: false,
    status: [],
    method: [],
    samplingRate: undefined,
    search: undefined,
    outcome: [],
  };
  const split = (value: string) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--recent") parsed.recent = true;
    else if (arg === "--sprout") parsed.sprout = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      if (!VALUE_FLAGS.some((known) => known === flag)) return { error: `tail: unknown flag "${flag}"` };
      const value = eq < 0 ? args[++index] : arg.slice(eq + 1);
      if (value === undefined || (eq < 0 && value.startsWith("--"))) return { error: `tail: ${flag} needs a value` };
      if (flag === "--format") {
        if (value !== "pretty" && value !== "json")
          return { error: `tail: --format must be pretty or json (got "${value}")` };
        parsed.format = value;
      } else if (flag === "--status") parsed.status.push(...split(value));
      else if (flag === "--method") parsed.method.push(...split(value).map((method) => method.toUpperCase()));
      else if (flag === "--outcome") parsed.outcome.push(...split(value));
      else if (flag === "--sampling-rate") parsed.samplingRate = value;
      else parsed.search = value;
    } else if (parsed.dir === undefined) parsed.dir = arg;
    else return { error: `tail: unexpected argument "${arg}"` };
  }
  const filtered =
    parsed.status.length || parsed.method.length || parsed.outcome.length || parsed.samplingRate || parsed.search;
  if (parsed.recent && parsed.sprout) return { error: "tail: --recent and --sprout are alternatives" };
  if ((parsed.recent || parsed.sprout) && filtered)
    return { error: "tail: filters apply to the live stream, not --recent or --sprout" };
  for (const status of parsed.status) {
    if (!/^(ok|error|[1-5]xx|[1-5]\d\d)$/i.test(status))
      return {
        error: `tail: --status must be ok, error, a code such as 404, or a class such as 5xx (got "${status}")`,
      };
  }
  if (parsed.samplingRate !== undefined) {
    const rate = Number(parsed.samplingRate);
    if (parsed.samplingRate.trim() === "" || !Number.isFinite(rate) || rate < 0 || rate > 1)
      return { error: "tail: --sampling-rate must be a number from 0 to 1" };
  }
  return { args: parsed };
}

/** Query string for the live endpoint. Repeatable filters repeat the parameter. */
export function tailQuery(args: TailArgs): string {
  const params = new URLSearchParams();
  for (const status of args.status) params.append("status", status);
  for (const method of args.method) params.append("method", method);
  for (const outcome of args.outcome) params.append("outcome", outcome);
  if (args.samplingRate !== undefined) params.set("sampling-rate", args.samplingRate);
  if (args.search) params.set("search", args.search);
  return params.toString();
}

/** Decode an SSE body into frames; comments (keepalives) and malformed data are skipped. */
export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<TailFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        const frame = toFrame(data);
        if (frame) yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toFrame(data: string): TailFrame | undefined {
  let value: JsonObject | undefined;
  try {
    value = jsonObject(parseJsonValue(data));
  } catch {
    return undefined;
  }
  if (!value) return undefined;
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "closed":
      return { type: "closed", reason: isString(value.reason) ? value.reason : "" };
    case "dropped":
      return {
        type: "dropped",
        count: num(value.count) ?? 0,
        bytes: num(value.bytes),
        reason: isString(value.reason) ? value.reason : "",
      };
    case "event": {
      const event = toEvent(value.event);
      return event ? { type: "event", event } : undefined;
    }
    default:
      return undefined;
  }
}

function num(value: JsonValue | undefined): number | undefined {
  return value !== undefined && Object(value) !== value && value === Number(value) && Number.isFinite(value)
    ? value
    : undefined;
}

function objects(value: JsonValue | undefined): JsonObject[] {
  const found: JsonObject[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const object = jsonObject(entry);
    if (object) found.push(object);
  }
  return found;
}

function toEvent(value: JsonValue | undefined): TailEvent | undefined {
  const event = value === undefined ? undefined : jsonObject(value);
  if (!event || !isString(event.outcome)) return undefined;
  const eventTimestamp = num(event.eventTimestamp);
  if (eventTimestamp === undefined) return undefined;
  const inner = jsonObject(event.event ?? null);
  const request = jsonObject(inner?.request ?? null);
  const response = jsonObject(inner?.response ?? null);
  return {
    scriptName: isString(event.scriptName) ? event.scriptName : "",
    outcome: event.outcome,
    eventTimestamp,
    event:
      request && response
        ? {
            request: {
              url: isString(request.url) ? request.url : "",
              method: isString(request.method) ? request.method : "",
            },
            response: { status: num(response.status) ?? 0 },
          }
        : null,
    cpuTime: num(event.cpuTime) ?? null,
    wallTime: num(event.wallTime) ?? 0,
    logs: objects(event.logs).map((log) => ({
      level: isString(log.level) ? log.level : "log",
      message: Array.isArray(log.message) ? log.message : [],
      timestamp: num(log.timestamp) ?? 0,
    })),
    exceptions: objects(event.exceptions).map((exception) => ({
      name: isString(exception.name) ? exception.name : "Error",
      message: isString(exception.message) ? exception.message : "",
      timestamp: num(exception.timestamp) ?? 0,
      stack: isString(exception.stack) ? exception.stack : undefined,
    })),
  };
}

const CROSS = "\u2717";

const clock = (ms: number): string => {
  const date = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

function statusColor(status: number, text: string): string {
  if (status >= 500) return rose(text);
  if (status >= 400) return amber(text);
  if (status >= 300) return dim(text);
  return leaf(text);
}

const message = (parts: JsonValue[]): string =>
  parts.map((part) => (isString(part) ? part : JSON.stringify(part))).join(" ");

/**
 * Pretty lines for one event: the request line (time, method, url, status,
 * outcome, cpu and wall ms), then its console lines and exceptions indented. A
 * console-only event (the usual case, see the module comment) prints flush left
 * so it does not read as belonging to the request printed above it.
 */
export function formatEvent(event: TailEvent): string[] {
  const lines: string[] = [];
  const time = dim(clock(event.eventTimestamp));
  const indent = event.event ? "  " : "";
  if (event.event) {
    const { request, response } = event.event;
    const cpu = event.cpuTime === null ? "cpu -" : `cpu ${Number(event.cpuTime.toFixed(2))}ms`;
    const outcome = event.outcome === "ok" ? dim("ok") : rose(event.outcome);
    lines.push(
      `${time}  ${bold(request.method.padEnd(6))} ${request.url}  ${statusColor(response.status, String(response.status))}  ${outcome}  ${dim(`${cpu}, wall ${event.wallTime}ms`)}`,
    );
  }
  for (const log of event.logs) {
    const level = log.level === "error" ? rose(log.level) : log.level === "warn" ? amber(log.level) : dim(log.level);
    for (const [index, text] of message(log.message).split("\n").entries()) {
      lines.push(event.event || index > 0 ? `${indent}${dim("|")} ${text}` : `${time}  ${level}  ${text}`);
    }
  }
  for (const exception of event.exceptions) {
    lines.push(`${event.event ? indent : `${time}  `}${rose(`${CROSS} ${exception.name}: ${exception.message}`)}`);
    for (const frame of (exception.stack ?? "").split("\n").slice(1)) lines.push(`${indent}${dim(frame.trimEnd())}`);
  }
  return lines;
}

export type RunTailOptions = {
  url: string;
  headers: Record<string, string>;
  format: TailFormat;
  signal: AbortSignal;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** First delay after a failed connection; doubles up to 8 seconds. */
  retryMs?: number;
  /** Give up after this many failed connections in a row. */
  maxFailures?: number;
  /** Reconnect if the server sends nothing (not even a keepalive) for this long. */
  idleMs?: number;
  fetchFn?: typeof fetch;
};

/** How a stream attempt ended, so the caller can decide to retry or stop. */
export class TailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Stream until `signal` aborts. Reconnects when the server closes the stream
 * (its time cap) or the link drops; a 4xx answer (bad filter, no auth, no such
 * project) is final.
 */
export async function runTail(options: RunTailOptions): Promise<void> {
  const out = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = options.stderr ?? ((text: string) => void process.stderr.write(text));
  const fetchFn = options.fetchFn ?? fetch;
  const idleMs = options.idleMs ?? 45_000;
  const maxFailures = options.maxFailures ?? 5;
  let delay = options.retryMs ?? 500;
  let failures = 0;
  let announced = false;

  while (!options.signal.aborted) {
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    options.signal.addEventListener("abort", stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => attempt.abort(), idleMs);
    };
    try {
      arm();
      const response = await fetchFn(options.url, {
        headers: { ...options.headers, accept: "text/event-stream" },
        signal: attempt.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)
          throw new TailError(
            response.status === 404
              ? "live tail is not available here: the project was not found, or this control plane predates `tail` streaming (use `sproutboat tail --recent`)"
              : `could not start the tail (${response.status}): ${errorText(detail)}`,
            response.status,
          );
        throw new Error(`control plane answered ${response.status}`);
      }
      let sawFrame = false;
      for await (const frame of readFrames(response.body)) {
        arm();
        sawFrame = true;
        failures = 0;
        delay = options.retryMs ?? 500;
        if (frame.type === "ready") {
          if (options.format === "pretty" && !announced) err(`${dim("tailing live, Ctrl-C to stop")}\n`);
          announced = true;
        } else if (frame.type === "event") {
          if (options.format === "json") out(`${JSON.stringify(frame.event)}\n`);
          else for (const line of formatEvent(frame.event)) out(`${line}\n`);
        } else if (frame.type === "dropped") {
          const what = frame.count > 0 ? `${frame.count} events` : `${frame.bytes ?? 0} bytes of output`;
          err(`${amber(`! ${what} dropped (${frame.reason === "rate" ? "event rate limit" : "output backlog"})`)}\n`);
        }
        // "closed" is the server's time cap: fall out of the loop and reconnect.
      }
      if (!sawFrame) throw new Error("stream ended before it started");
    } catch (error) {
      if (options.signal.aborted) break;
      if (error instanceof TailError) throw error;
      failures += 1;
      if (failures >= maxFailures)
        throw new TailError(
          `lost the connection ${failures} times in a row: ${error instanceof Error ? error.message : String(error)}`,
        );
      if (options.format === "pretty") err(`${amber("! connection lost, retrying")}\n`);
      await sleep(delay, options.signal);
      delay = Math.min(delay * 2, 8000);
    } finally {
      clearTimeout(idle);
      options.signal.removeEventListener("abort", stop);
      attempt.abort();
    }
  }
}

function errorText(body: string): string {
  try {
    const error = jsonObject(parseJsonValue(body))?.error;
    if (error !== undefined && isString(error)) return error;
  } catch {
    /* plain text */
  }
  return body.trim() || "no detail";
}
