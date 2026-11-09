/**
 * `sproutboat tail --file <log>`: follow the structured records a standalone
 * binary writes when it runs with `SB_LOG=json` (#268). No control plane and
 * no login are involved; the log is whatever the operator already keeps:
 *
 *     SB_LOG=json ./app 2>> /var/log/app.jsonl
 *     sproutboat tail --file /var/log/app.jsonl
 *     journalctl -u app -f -o cat | sproutboat tail --file -
 *
 * Records are `request`, `error` and `dropped` lines of version 1. Anything
 * else in the file (the app's own console output, a startup banner, a record
 * of a newer version) is skipped. Output stays bounded and safe to pipe:
 * only known fields are kept and cut to fixed lengths, whatever the file
 * holds, so a hostile or oversized line cannot grow memory, inject terminal
 * escapes or add fields to `--format json` output.
 *
 * Reconnect behavior while following a file: it is polled, and a missing file
 * is waited for; a file replaced by rotation (a new inode) or truncated in
 * place is reopened from its start. Following ends on SIGINT or SIGTERM
 * (exit 0). With `-` (stdin) it ends when the input does.
 */
import { open, stat, type FileHandle } from "node:fs/promises";
import { isSafeInteger, isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";
import { amber, bold, dim, leaf, rose } from "./style";

export type LogRequest = {
  type: "request";
  id: string;
  timestamp: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  outcome: string;
};
export type LogError = {
  type: "error";
  id: string | null;
  timestamp: number;
  source: string;
  name: string;
  message: string;
  stack?: string;
};
export type LogDropped = { type: "dropped"; timestamp: number; count: number };
export type LogRecord = LogRequest | LogError | LogDropped;

const MAX_ID = 64;
const MAX_METHOD = 16;
const MAX_PATH = 256;
const MAX_SOURCE = 40;
const MAX_NAME = 100;
const MAX_MESSAGE = 1000;
const MAX_STACK = 2000;
/** The longest line read; a longer one is skipped, never held in memory. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
/** How much of the end of a file is looked at to find the last lines. */
const SNAPSHOT_WINDOW_BYTES = 256 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_LINES = 100_000;

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);
const count = (value: JsonValue | undefined): number | undefined =>
  isSafeInteger(value) && value >= 0 ? value : undefined;

/** One log line as a record, or undefined when it is not a version 1 record. */
export function parseLogLine(line: string): LogRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let record: JsonObject | undefined;
  try {
    record = jsonObject(parseJsonValue(trimmed));
  } catch {
    return undefined;
  }
  if (!record || record.v !== 1) return undefined;
  const timestamp = count(record.timestamp);
  if (timestamp === undefined) return undefined;
  if (record.type === "request") {
    const status = count(record.status);
    if (!isString(record.id) || !isString(record.method) || !isString(record.path) || status === undefined)
      return undefined;
    return {
      type: "request",
      id: cut(record.id, MAX_ID),
      timestamp,
      method: cut(record.method, MAX_METHOD),
      path: cut(record.path, MAX_PATH),
      status,
      durationMs: count(record.durationMs) ?? 0,
      outcome: isString(record.outcome) ? cut(record.outcome, MAX_NAME) : "ok",
    };
  }
  if (record.type === "error") {
    if (!isString(record.source) || !isString(record.name) || !isString(record.message)) return undefined;
    const error: LogError = {
      type: "error",
      id: isString(record.id) ? cut(record.id, MAX_ID) : null,
      timestamp,
      source: cut(record.source, MAX_SOURCE),
      name: cut(record.name, MAX_NAME),
      message: cut(record.message, MAX_MESSAGE),
    };
    if (isString(record.stack)) error.stack = cut(record.stack, MAX_STACK);
    return error;
  }
  if (record.type === "dropped") return { type: "dropped", timestamp, count: count(record.count) ?? 0 };
  return undefined;
}

type StatusMatcher =
  | { kind: "ok" }
  | { kind: "error" }
  | { kind: "class"; digit: number }
  | { kind: "code"; code: number };

const MAX_PENDING_ERRORS = 200;

export type LogFilterInput = { status: string[]; method: string[]; search: string | undefined };

/**
 * `--status`, `--method` and `--search` for a log. Status and method describe a
 * request, so they select request records; an error follows the request it was
 * raised in (shown when that request was), and an error with no request (an
 * alarm, a queue, a rejected promise) is always shown. The meanings match the
 * live tail: `ok` is a success below 400, `error` is a 5xx or a thrown handler.
 */
export class LogFilter {
  private readonly status: StatusMatcher[];
  private readonly method: string[];
  private readonly search: string | undefined;
  private readonly shown = new Map<string, boolean>();
  /** Errors whose request record has not arrived yet: the runtime writes an error before its request's record. */
  private readonly pending = new Map<string, LogError>();

  constructor(input: LogFilterInput) {
    this.status = input.status.map((value): StatusMatcher => {
      const lower = value.toLowerCase();
      if (lower === "ok" || lower === "error") return { kind: lower };
      if (/^[1-5]xx$/.test(lower)) return { kind: "class", digit: Number(lower[0]) };
      return { kind: "code", code: Number(lower) };
    });
    this.method = input.method.map((value) => value.toUpperCase());
    this.search = input.search?.toLowerCase();
  }

  /**
   * The records to print for `record`, in order. An error raised while answering a request is written
   * before that request's record, so under a status or method filter it waits for the request (up to
   * 200 at a time, oldest dropped) and is printed just before it, or discarded with it.
   */
  accept(record: LogRecord): LogRecord[] {
    if (record.type === "error" && record.id !== null && !this.shown.has(record.id)) {
      const filtered = this.status.length > 0 || this.method.length > 0;
      if (filtered) {
        if (this.search !== undefined && !this.haystack(record).includes(this.search)) return [];
        if (this.pending.size >= MAX_PENDING_ERRORS) {
          const oldest = this.pending.keys().next();
          if (!oldest.done) this.pending.delete(oldest.value);
        }
        this.pending.set(record.id, record);
        return [];
      }
    }
    const passes = this.matches(record);
    if (record.type !== "request") return passes ? [record] : [];
    const waiting = this.pending.get(record.id);
    this.pending.delete(record.id);
    return passes ? (waiting ? [waiting, record] : [record]) : [];
  }

  matches(record: LogRecord): boolean {
    if (record.type === "dropped") return true;
    const searched = this.search === undefined || this.haystack(record).includes(this.search);
    if (record.type === "request") {
      const passes = searched && this.requestMatches(record);
      this.remember(record.id, passes);
      return passes;
    }
    if (!searched) return false;
    if (record.id === null) return true;
    // An error whose request is unknown (before the window, or filtered by search only) follows the filters it can.
    return this.shown.get(record.id) ?? (this.status.length === 0 && this.method.length === 0);
  }

  private requestMatches(record: LogRequest): boolean {
    if (this.method.length > 0 && !this.method.includes(record.method.toUpperCase())) return false;
    if (this.status.length === 0) return true;
    return this.status.some((matcher) => {
      switch (matcher.kind) {
        case "ok":
          return record.outcome === "ok" && record.status < 400;
        case "error":
          return record.status >= 500 || record.outcome !== "ok";
        case "code":
          return record.status === matcher.code;
        case "class":
          return Math.floor(record.status / 100) === matcher.digit;
      }
    });
  }

  private haystack(record: LogRequest | LogError): string {
    return (
      record.type === "request"
        ? `${record.method} ${record.path}`
        : `${record.source} ${record.name} ${record.message}`
    ).toLowerCase();
  }

  private remember(id: string, shown: boolean): void {
    // Bounded: only the most recent requests are remembered.
    if (this.shown.size >= 2000) {
      const oldest = this.shown.keys().next();
      if (!oldest.done) this.shown.delete(oldest.value);
    }
    this.shown.set(id, shown);
  }
}

/** Newlines and tabs become spaces and other control characters "?", so a path or message cannot move the cursor or recolor the terminal. */
const printable = (text: string): string => text.replace(/[\n\t]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

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

/** One pretty line for a record. */
export function formatLogRecord(record: LogRecord): string {
  const time = dim(clock(record.timestamp));
  if (record.type === "dropped") {
    return `${time}  ${amber(`! ${record.count} records dropped (the app was writing over its rate limit)`)}`;
  }
  if (record.type === "request") {
    const outcome = record.outcome === "ok" ? dim("ok") : rose(printable(record.outcome));
    return `${time}  ${bold(printable(record.method).padEnd(6))} ${printable(record.path)}  ${statusColor(record.status, String(record.status))}  ${outcome}  ${dim(`${record.durationMs}ms  ${printable(record.id)}`)}`;
  }
  const message = printable(record.message);
  const id = record.id === null ? "" : `  ${dim(printable(record.id))}`;
  return `${time}  ${rose(`✗ [${printable(record.source)}] ${printable(record.name)}: ${message}`)}${id}`;
}

export type LogSinkOptions = {
  format: "pretty" | "json";
  filter: LogFilter;
  signal: AbortSignal;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export type LogTailOptions = LogSinkOptions & {
  path: string;
  /** How many of the file's last matching lines to print first. */
  lines: number;
  /** Keep following after the snapshot. */
  follow: boolean;
  /** Poll interval of a followed file. */
  pollMs?: number;
  maxLineBytes?: number;
  /** Called once the file is open and its snapshot is printed: anything appended after this is followed. */
  onReady?: () => void;
};

/** Turns lines into output. One per run, so a skipped-line count covers the whole run. */
class LogPrinter {
  private skipped = 0;
  private skippedLimit = DEFAULT_MAX_LINE_BYTES;
  constructor(private readonly options: LogSinkOptions) {}

  line(text: string): void {
    const record = parseLogLine(text);
    if (!record) return;
    for (const out of this.options.filter.accept(record)) this.emit(out);
  }

  emit(record: LogRecord): void {
    // The record version rides along in JSON output, as it does in the log.
    const { type, ...fields } = record;
    const json = JSON.stringify({ type, v: 1, ...fields });
    this.options.stdout(`${this.options.format === "json" ? json : formatLogRecord(record)}\n`);
  }

  skipLine(limit: number): void {
    this.skipped += 1;
    this.skippedLimit = limit;
    this.options.stderr(
      `${amber(`! ${this.skipped} line${this.skipped === 1 ? "" : "s"} over ${limit} bytes skipped`)}\n`,
    );
  }
}

/** Splits bytes into lines of at most `maxBytes`; a longer line is skipped to its end. */
class LineSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  private skipping = false;
  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onSkip: () => void,
  ) {}

  push(chunk: Uint8Array): void {
    let data: Buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    this.buffer = Buffer.alloc(0);
    for (;;) {
      const newline = data.indexOf(10);
      if (newline < 0) break;
      const line = data.subarray(0, newline);
      data = data.subarray(newline + 1);
      if (this.skipping) this.skipping = false;
      else if (line.length > this.maxBytes) this.onSkip();
      else this.onLine(line.toString("utf8"));
    }
    if (this.skipping) return;
    if (data.length > this.maxBytes) {
      this.skipping = true;
      this.onSkip();
      return;
    }
    this.buffer = Buffer.from(data);
  }

  /** Input ended without a final newline: a complete record is still a record. */
  flush(): void {
    if (!this.skipping && this.buffer.length > 0) this.onLine(this.buffer.toString("utf8"));
    this.buffer = Buffer.alloc(0);
  }
}

/** Records from a stream (stdin) until it ends or the signal aborts. */
export async function readLogStream(body: ReadableStream<Uint8Array>, options: LogSinkOptions): Promise<void> {
  const printer = new LogPrinter(options);
  const splitter = new LineSplitter(
    DEFAULT_MAX_LINE_BYTES,
    (line) => printer.line(line),
    () => printer.skipLine(DEFAULT_MAX_LINE_BYTES),
  );
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      splitter.push(next.value);
    }
    if (!options.signal.aborted) splitter.flush();
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    options.signal.removeEventListener("abort", onAbort);
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

const isMissing = (error: Error): boolean => "code" in error && error.code === "ENOENT";

/** The last `lines` matching records among the final complete lines of the file's last 256 KiB. */
async function snapshot(handle: FileHandle, size: number, printer: LogPrinter, options: LogTailOptions): Promise<void> {
  if (options.lines === 0 || size === 0) return;
  const start = Math.max(0, size - SNAPSHOT_WINDOW_BYTES);
  const buffer = Buffer.alloc(size - start);
  await handle.read(buffer, 0, buffer.length, start);
  let text = buffer.toString("utf8");
  // The window can begin mid-line: drop that first fragment.
  if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  const picked: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (Buffer.byteLength(line) > (options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) continue;
    const record = parseLogLine(line);
    if (record) picked.push(...options.filter.accept(record));
  }
  for (const record of picked.slice(-options.lines)) printer.emit(record);
}

/**
 * Print the file's last lines, then (unless `follow` is false) new records as
 * they are appended, until the signal aborts.
 */
export async function followLog(options: LogTailOptions): Promise<void> {
  const printer = new LogPrinter(options);
  const pollMs = options.pollMs ?? 250;
  const maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  let announcedWait = false;
  let first = true;

  while (!options.signal.aborted) {
    let handle: FileHandle;
    try {
      handle = await open(options.path, "r");
    } catch (error) {
      if (!(error instanceof Error) || !isMissing(error)) throw error;
      if (!options.follow) throw new Error(`no such log file: ${options.path}`);
      if (!announcedWait) options.stderr(`${dim(`waiting for ${options.path}`)}\n`);
      announcedWait = true;
      await sleep(pollMs, options.signal);
      continue;
    }
    try {
      const opened = await handle.stat();
      let offset = 0;
      const splitter = new LineSplitter(
        maxLine,
        (line) => printer.line(line),
        () => printer.skipLine(maxLine),
      );
      // A file that was not there at the start is read from its first byte: everything in it is new.
      if (first && !announcedWait) {
        await snapshot(handle, opened.size, printer, options);
        offset = opened.size;
      }
      first = false;
      options.onReady?.();
      if (!options.follow) return;
      // On a reopened file (rotation, truncation, a late start) everything in it is new.
      for (;;) {
        const chunk = Buffer.alloc(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead > 0) {
          offset += bytesRead;
          splitter.push(chunk.subarray(0, bytesRead));
          continue;
        }
        if (options.signal.aborted) return;
        await sleep(pollMs, options.signal);
        if (options.signal.aborted) return;
        let current;
        try {
          current = await stat(options.path);
        } catch {
          // Removed while open: wait for the next one.
          options.stderr(`${dim(`${options.path} went away, waiting for it`)}\n`);
          break;
        }
        if (current.ino !== opened.ino || current.dev !== opened.dev) {
          // Drain the old file's last bytes first (the loop above ran to EOF just now), then switch.
          options.stderr(`${dim("log rotated, following the new file")}\n`);
          break;
        }
        if (current.size < offset) {
          options.stderr(`${dim("log truncated, reading from its start")}\n`);
          offset = 0;
          splitter.flush();
        }
      }
    } finally {
      await handle.close();
    }
  }
}
