import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./json";
import { parseTailArgs } from "./tail";
import {
  followLog,
  formatLogRecord,
  LogFilter,
  parseLogLine,
  readLogStream,
  type LogRecord,
  type LogTailOptions,
} from "./tail-log";

const parseArgs = (...args: string[]) => {
  const result = parseTailArgs(args);
  if ("error" in result) throw new Error(result.error);
  return result.args;
};
const argError = (...args: string[]) => {
  const result = parseTailArgs(args);
  return "error" in result ? result.error : "";
};

const request = (over: JsonObject = {}) =>
  JSON.stringify({
    type: "request",
    v: 1,
    id: "1-1",
    timestamp: new Date(2026, 0, 2, 3, 4, 5, 6).getTime(),
    method: "GET",
    path: "/api/notes",
    status: 200,
    durationMs: 12,
    outcome: "ok",
    ...over,
  });
const failure = (over: JsonObject = {}) =>
  JSON.stringify({
    type: "error",
    v: 1,
    id: "1-2",
    timestamp: new Date(2026, 0, 2, 3, 4, 6, 0).getTime(),
    source: "fetch",
    name: "TypeError",
    message: "bad thing",
    ...over,
  });

const collect = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text: string) => void out.push(text), stderr: (text: string) => void err.push(text) };
};
const lines = (out: string[]) =>
  out
    .join("")
    .split("\n")
    .filter((line) => line !== "");
const until = async (condition: () => boolean, what: string) => {
  for (let waited = 0; waited < 5000 && !condition(); waited += 10) await Bun.sleep(10);
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
};
const filter = (over: Partial<ConstructorParameters<typeof LogFilter>[0]> = {}) =>
  new LogFilter({ status: [], method: [], search: undefined, ...over });

test("arguments: --file, --lines and --no-follow", () => {
  expect(parseArgs("--file", "app.log")).toMatchObject({ file: "app.log", lines: 10, follow: true });
  expect(parseArgs("--file=-", "--lines", "0", "--no-follow", "--status", "5xx", "--format", "json")).toMatchObject({
    file: "-",
    lines: 0,
    follow: false,
    status: ["5xx"],
    format: "json",
  });
  expect(parseArgs()).toMatchObject({ file: undefined, follow: true });
  expect(argError("--file", "a.log", "--recent")).toContain("--file");
  expect(argError("--file", "a.log", "--sprout")).toContain("--file");
  expect(argError("--file", "a.log", "--sampling-rate", "0.5")).toContain("not available");
  expect(argError("--file", "a.log", "--outcome", "exception")).toContain("not available");
  expect(argError("./app", "--file", "a.log")).toContain("project");
  expect(argError("--lines", "5")).toContain("--file");
  expect(argError("--no-follow")).toContain("--file");
  expect(argError("--file", "a.log", "--lines", "-1")).toContain("--lines");
  expect(argError("--file", "a.log", "--lines", "many")).toContain("--lines");
  expect(argError("--file", "a.log", "--lines", "100001")).toContain("--lines");
});

test("records: requests, errors and dropped notices parse; everything else is skipped", () => {
  expect(parseLogLine(request())).toMatchObject({ type: "request", id: "1-1", status: 200, durationMs: 12 });
  expect(parseLogLine(failure())).toMatchObject({ type: "error", id: "1-2", source: "fetch", name: "TypeError" });
  expect(parseLogLine(failure({ id: null }))).toMatchObject({ type: "error", id: null });
  expect(
    parseLogLine(JSON.stringify({ type: "dropped", v: 1, timestamp: 5, count: 40, reason: "rate" })),
  ).toMatchObject({
    type: "dropped",
    count: 40,
  });
  for (const skipped of [
    "",
    "plain text from the app",
    "Uncaught (in fetch) Error: x",
    "{not json",
    "[]",
    "null",
    JSON.stringify({ type: "request", v: 2, id: "1", timestamp: 1, method: "GET", path: "/", status: 200 }),
    JSON.stringify({ type: "something-else", v: 1 }),
    request({ status: "200" }),
    request({ path: 5 }),
    request({ timestamp: "now" }),
  ]) {
    expect(parseLogLine(skipped)).toBeUndefined();
  }
});

test("records: only known fields survive, long fields are cut, so output stays bounded", () => {
  const record = parseLogLine(
    request({
      headers: { authorization: "Bearer leak" },
      body: "leaked body",
      query: "token=leak",
      path: `/${"p".repeat(2000)}`,
      id: "i".repeat(500),
      method: "M".repeat(100),
    }),
  );
  expect(record).toBeDefined();
  const text = JSON.stringify(record);
  expect(text).not.toContain("leak");
  expect(Object.keys(record ?? {}).sort()).toEqual(
    ["durationMs", "id", "method", "outcome", "path", "status", "timestamp", "type"].sort(),
  );
  expect(record?.type === "request" && record.path.length).toBeLessThanOrEqual(260);
  expect(record?.type === "request" && record.id.length).toBeLessThanOrEqual(64);
  const error = parseLogLine(failure({ message: "m".repeat(50_000), stack: "s".repeat(50_000), extra: "x" }));
  expect(error?.type === "error" && error.message.length).toBeLessThanOrEqual(1010);
  expect(error?.type === "error" && (error.stack ?? "").length).toBeLessThanOrEqual(2010);
  expect(JSON.stringify(error)).not.toContain('"extra"');
});

test("filters: status classes, codes, ok and error; methods; search", () => {
  const records = new Map<string, LogRecord>();
  for (const [name, line] of Object.entries({
    ok200: request({ status: 200 }),
    redirect: request({ status: 302 }),
    notFound: request({ status: 404, outcome: "ok" }),
    boom: request({ status: 500, outcome: "exception" }),
    post: request({ method: "POST", path: "/submit" }),
  })) {
    const parsed = parseLogLine(line);
    if (parsed) records.set(name, parsed);
  }
  const passes = (f: LogFilter) => [...records].filter(([, record]) => f.matches(record)).map(([name]) => name);
  expect(passes(filter())).toEqual(["ok200", "redirect", "notFound", "boom", "post"]);
  expect(passes(filter({ status: ["ok"] }))).toEqual(["ok200", "redirect", "post"]);
  expect(passes(filter({ status: ["error"] }))).toEqual(["boom"]);
  expect(passes(filter({ status: ["5xx"] }))).toEqual(["boom"]);
  expect(passes(filter({ status: ["404", "302"] }))).toEqual(["redirect", "notFound"]);
  expect(passes(filter({ method: ["POST"] }))).toEqual(["post"]);
  expect(passes(filter({ method: ["GET"], status: ["2xx"] }))).toEqual(["ok200"]);
  expect(passes(filter({ search: "SUBMIT" }))).toEqual(["post"]);
});

test("filters: an error follows its request; background errors always show", () => {
  const f = filter({ status: ["5xx"] });
  const hidden = parseLogLine(request({ id: "9-1", status: 200 }));
  const shown = parseLogLine(request({ id: "9-2", status: 500, outcome: "exception" }));
  const errorOfHidden = parseLogLine(failure({ id: "9-1" }));
  const errorOfShown = parseLogLine(failure({ id: "9-2" }));
  const background = parseLogLine(failure({ id: null, source: "alarm" }));
  expect(f.matches(hidden!)).toBe(false);
  expect(f.matches(shown!)).toBe(true);
  expect(f.matches(errorOfShown!)).toBe(true);
  expect(f.matches(errorOfHidden!)).toBe(false);
  expect(f.matches(background!)).toBe(true);
});

test("pretty: request and error lines carry what an operator needs and no control characters", () => {
  const req = parseLogLine(request({ status: 503, outcome: "exception", path: "/a\u001b[31mred" }));
  const err = parseLogLine(failure({ message: "line one\nline two\u0007", id: "7-3", source: "waitUntil" }));
  const line = formatLogRecord(req!);
  expect(line).toContain("GET");
  expect(line).toContain("/a?[31mred");
  expect(line).toContain("503");
  expect(line).toContain("12ms");
  expect(line).toContain("1-1");
  expect(line).not.toContain("\u001b[31mred");
  const errorLine = formatLogRecord(err!);
  expect(errorLine).toContain("waitUntil");
  expect(errorLine).toContain("TypeError: line one line two?");
  expect(errorLine).toContain("7-3");
  expect(errorLine).not.toContain("\n");
  expect(
    formatLogRecord(parseLogLine(JSON.stringify({ type: "dropped", v: 1, timestamp: 1, count: 3, reason: "rate" }))!),
  ).toContain("3 records dropped");
});

async function withLog<T>(run: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sb-tail-log-"));
  try {
    return await run(join(dir, "app.jsonl"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const options = (path: string, over: Partial<LogTailOptions> = {}) => {
  const sink = collect();
  const controller = new AbortController();
  const settings: LogTailOptions = {
    path,
    lines: 10,
    follow: true,
    format: "json",
    filter: filter(),
    signal: controller.signal,
    stdout: sink.stdout,
    stderr: sink.stderr,
    pollMs: 10,
    ...over,
  };
  return { sink, controller, settings };
};

/** Start following and resolve once the file is open, so appends after this are seen. */
const begin = (settings: LogTailOptions) => {
  let ready!: () => void;
  const opened = new Promise<void>((resolve) => (ready = resolve));
  const done = followLog({ ...settings, onReady: ready });
  return { done, opened };
};

test("follow: prints the last lines, then new requests as they arrive", async () => {
  await withLog(async (path) => {
    await writeFile(path, [1, 2, 3, 4].map((n) => request({ id: `a-${n}`, path: `/old${n}` })).join("\n") + "\n");
    const { sink, controller, settings } = options(path, { lines: 2 });
    const { done, opened } = begin(settings);
    await opened;
    await until(() => lines(sink.out).length === 2, "the initial lines");
    expect(lines(sink.out).map((line) => JSON.parse(line).id)).toEqual(["a-3", "a-4"]);
    await appendFile(path, `${request({ id: "b-1", path: "/live" })}\nplain text noise\n${failure({ id: "b-1" })}\n`);
    await until(() => lines(sink.out).length === 4, "the appended records");
    controller.abort();
    await done;
    const parsed = lines(sink.out).map((line) => JSON.parse(line));
    expect(parsed.map((record) => record.type)).toEqual(["request", "request", "request", "error"]);
    expect(parsed[3].id).toBe("b-1");
  });
});

test("follow: a half-written line waits for its newline", async () => {
  await withLog(async (path) => {
    await writeFile(path, "");
    const { sink, controller, settings } = options(path, { lines: 0 });
    const { done, opened } = begin(settings);
    await opened;
    const whole = request({ id: "half-1" });
    await appendFile(path, whole.slice(0, 30));
    await Bun.sleep(80);
    expect(lines(sink.out)).toEqual([]);
    await appendFile(path, `${whole.slice(30)}\n`);
    await until(() => lines(sink.out).length === 1, "the completed line");
    controller.abort();
    await done;
    expect(JSON.parse(lines(sink.out)[0]).id).toBe("half-1");
  });
});

test("follow: filters apply, and --lines 0 starts at the end", async () => {
  await withLog(async (path) => {
    await writeFile(path, `${request({ id: "old", status: 500 })}\n`);
    const { sink, controller, settings } = options(path, {
      lines: 0,
      filter: filter({ status: ["5xx"], method: ["GET"] }),
    });
    const { done, opened } = begin(settings);
    await opened;
    await Bun.sleep(50);
    await appendFile(
      path,
      [
        request({ id: "n-1", status: 200 }),
        request({ id: "n-2", status: 500, outcome: "exception" }),
        request({ id: "n-3", status: 500, method: "POST" }),
        request({ id: "n-4", status: 503, outcome: "exception" }),
      ].join("\n") + "\n",
    );
    await until(() => lines(sink.out).length === 2, "the filtered records");
    await Bun.sleep(50);
    controller.abort();
    await done;
    expect(lines(sink.out).map((line) => JSON.parse(line).id)).toEqual(["n-2", "n-4"]);
  });
});

test("follow: reconnects across rotation, truncation and a file that appears late", async () => {
  await withLog(async (path, dir) => {
    const { sink, controller, settings } = options(path, { lines: 0 });
    const done = followLog(settings);
    // not there yet
    await until(() => sink.err.join("").includes("waiting for"), "the waiting notice");
    await writeFile(path, `${request({ id: "late-1" })}\n`);
    await until(() => lines(sink.out).length === 1, "a record from the late file");
    // rotation: the old file is renamed away and a new one takes its place
    await rename(path, join(dir, "app.jsonl.1"));
    await writeFile(path, `${request({ id: "rot-1" })}\n`);
    await until(() => lines(sink.out).length === 2, "a record after rotation");
    // truncation in place
    await truncate(path, 0);
    await Bun.sleep(60);
    // Shorter than what was read, so a truncation is seen however the poll falls (a file that regrows
    // past its old length between two polls is indistinguishable from an append).
    await appendFile(
      path,
      `${JSON.stringify({ type: "request", v: 1, id: "trunc-1", timestamp: 1, method: "G", path: "/", status: 200 })}\n`,
    );
    await until(() => lines(sink.out).length === 3, "a record after truncation");
    controller.abort();
    await done;
    expect(lines(sink.out).map((line) => JSON.parse(line).id)).toEqual(["late-1", "rot-1", "trunc-1"]);
    const notices = sink.err.join("");
    // Between the rename and the new file a poll may find no file at all; either notice is a valid reconnect.
    expect(notices).toMatch(/rotated|went away/);
    expect(notices).toContain("truncated");
  });
});

test("follow: an oversized line is skipped and counted, never buffered without bound", async () => {
  await withLog(async (path) => {
    await writeFile(path, "");
    const { sink, controller, settings } = options(path, { lines: 0, maxLineBytes: 1024 });
    const { done, opened } = begin(settings);
    await opened;
    await appendFile(path, `${"x".repeat(100_000)}\n${request({ id: "after-big" })}\n`);
    await until(() => lines(sink.out).length === 1, "the record after the oversized line");
    controller.abort();
    await done;
    expect(JSON.parse(lines(sink.out)[0]).id).toBe("after-big");
    expect(sink.err.join("")).toContain("1 line over 1024 bytes skipped");
  });
});

test("--no-follow prints the snapshot and returns; JSON mode keeps stdout parseable", async () => {
  await withLog(async (path) => {
    await writeFile(path, `junk\n${request({ id: "s-1" })}\n${failure({ id: "s-1" })}\n`);
    const { sink, settings } = options(path, { follow: false, format: "json" });
    await followLog(settings);
    for (const line of lines(sink.out)) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines(sink.out)).toHaveLength(2);
    expect(JSON.parse(lines(sink.out)[0])).toMatchObject({ type: "request", v: 1, id: "s-1" });
    const pretty = options(path, { follow: false, format: "pretty" });
    await followLog(pretty.settings);
    expect(lines(pretty.sink.out)).toHaveLength(2);
    expect(pretty.sink.out.join("")).toContain("/api/notes");
  });
});

test("a missing file with --no-follow is an error that names the file", async () => {
  await withLog(async (path) => {
    const { settings } = options(path, { follow: false });
    await expect(followLog(settings)).rejects.toThrow(path);
  });
});

test("stdin: records stream through until end of input", async () => {
  const sink = collect();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const text = `noise\n${request({ id: "p-1" })}\n${request({ id: "p-2", status: 500 })}\n${failure({ id: "p-2" })}`;
      controller.enqueue(encoder.encode(text.slice(0, 40)));
      controller.enqueue(encoder.encode(text.slice(40)));
      controller.close();
    },
  });
  await readLogStream(body, {
    format: "json",
    filter: filter({ status: ["5xx"] }),
    signal: new AbortController().signal,
    stdout: sink.stdout,
    stderr: sink.stderr,
  });
  expect(lines(sink.out).map((line) => JSON.parse(line).id)).toEqual(["p-2", "p-2"]);
});

test("sproutboat tail --file follows a log through the real command, needs no login, exits 0 on SIGINT", async () => {
  await withLog(async (path, dir) => {
    await writeFile(path, `${request({ id: "cli-old" })}\n`);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "main.ts"), "tail", "--file", path, "--format", "json", "--lines", "0"],
      {
        env: {
          ...process.env,
          // no credentials anywhere: the command must not need them
          SPROUTBOAT_CONFIG_DIR: join(dir, "no-config"),
          SPROUTBOAT_API_URL: "http://127.0.0.1:9",
          SPROUTBOAT_TOKEN: "",
          SPROUTBOAT_NO_UPDATE_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    // The command takes a moment to start; keep adding requests until one comes through. Each is
    // appended after the start of the file, so only a command that is following can print one.
    let added = 0;
    const adder = setInterval(() => {
      added += 1;
      void appendFile(path, `${request({ id: `cli-live-${added}`, status: 201 })}\n`);
    }, 200);
    let first;
    try {
      first = await Promise.race([
        reader.read(),
        Bun.sleep(10_000).then(() => {
          throw new Error("no record within 10s");
        }),
      ]);
    } finally {
      clearInterval(adder);
    }
    const record = JSON.parse(new TextDecoder().decode(first.value).split("\n")[0]);
    expect(record).toMatchObject({ type: "request", status: 201 });
    expect(record.id).toStartWith("cli-live-");
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
  });
});

test("sproutboat tail --file - reads a pipe and exits at its end, with --status applied", async () => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "main.ts"), "tail", "--file", "-", "--format", "json", "--status", "5xx"],
    {
      env: { ...process.env, SPROUTBOAT_NO_UPDATE_CHECK: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    `${request({ id: "i-1" })}\nnoise\n${request({ id: "i-2", status: 502, outcome: "exception" })}\n${failure({ id: "i-2" })}\n`,
  );
  child.stdin.end();
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(lines([out]).map((line) => JSON.parse(line).id)).toEqual(["i-2", "i-2"]);
});
