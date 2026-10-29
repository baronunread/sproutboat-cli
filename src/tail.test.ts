import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEvent, parseTailArgs, readFrames, runTail, tailQuery, TailError, type TailEvent } from "./tail";

const parse = (...args: string[]) => {
  const result = parseTailArgs(args);
  if ("error" in result) throw new Error(result.error);
  return result.args;
};
const failure = (...args: string[]) => {
  const result = parseTailArgs(args);
  return "error" in result ? result.error : "";
};

const request = (over: Partial<TailEvent> = {}): TailEvent => ({
  scriptName: "app",
  outcome: "ok",
  eventTimestamp: new Date(2026, 0, 2, 3, 4, 5, 6).getTime(),
  event: { request: { url: "https://app.alice.test/api", method: "GET" }, response: { status: 200 } },
  cpuTime: 3.456,
  wallTime: 12,
  logs: [],
  exceptions: [],
  ...over,
});

test("arguments: defaults, repeatable and comma filters, = form, project dir", () => {
  expect(parse()).toMatchObject({ format: "pretty", recent: false, sprout: false, status: [], dir: undefined });
  const args = parse(
    "./app",
    "--status",
    "500,4xx",
    "--status=ok",
    "--method",
    "get,post",
    "--method",
    "put",
    "--sampling-rate",
    "0.1",
    "--search",
    "needle in",
    "--outcome",
    "exception",
    "--format",
    "json",
  );
  expect(args).toMatchObject({
    dir: "./app",
    format: "json",
    status: ["500", "4xx", "ok"],
    method: ["GET", "POST", "PUT"],
    samplingRate: "0.1",
    search: "needle in",
    outcome: ["exception"],
  });
  expect(new URLSearchParams(tailQuery(args)).getAll("method")).toEqual(["GET", "POST", "PUT"]);
  expect(new URLSearchParams(tailQuery(args)).get("search")).toBe("needle in");
  expect(new URLSearchParams(tailQuery(args)).get("sampling-rate")).toBe("0.1");
  expect(tailQuery(parse())).toBe("");
});

test("arguments: rejects bad input", () => {
  expect(failure("--format", "xml")).toContain("pretty or json");
  expect(failure("--status", "teapot")).toContain("--status");
  expect(failure("--status", "700")).toContain("--status");
  expect(failure("--sampling-rate", "2")).toContain("0 to 1");
  expect(failure("--sampling-rate", "x")).toContain("0 to 1");
  expect(failure("--search")).toContain("needs a value");
  expect(failure("--search", "--format")).toContain("needs a value");
  expect(failure("--nope")).toContain("unknown flag");
  expect(failure("a", "b")).toContain("unexpected argument");
  expect(failure("--recent", "--sprout")).toContain("alternatives");
  expect(failure("--recent", "--status", "5xx")).toContain("live stream");
  expect(parse("--recent").recent).toBe(true);
  expect(parse("--sprout").sprout).toBe(true);
});

test("pretty: request line has time, method, url, status, outcome, cpu and wall", () => {
  const [line, ...rest] = formatEvent(request());
  expect(rest).toEqual([]);
  expect(line).toBe("03:04:05.006  GET    https://app.alice.test/api  200  ok  cpu 3.46ms, wall 12ms");
  expect(formatEvent(request({ cpuTime: null }))[0]).toContain("cpu -, wall 12ms");
  expect(formatEvent(request({ outcome: "exceededWallTime" }))[0]).toContain("exceededWallTime");
});

test("pretty: console-only events print flush left, exceptions carry their stack", () => {
  const lines = formatEvent(
    request({
      event: null,
      cpuTime: null,
      wallTime: 0,
      logs: [
        { level: "log", message: ["hello", { a: 1 }], timestamp: 1 },
        { level: "warn", message: ["two\nlines"], timestamp: 1 },
      ],
    }),
  );
  expect(lines).toEqual(['03:04:05.006  log  hello {"a":1}', "03:04:05.006  warn  two", "| lines"]);
  const thrown = formatEvent(
    request({
      event: null,
      outcome: "exception",
      exceptions: [
        {
          name: "TypeError",
          message: "bad",
          timestamp: 1,
          stack: "Uncaught (in fetch) TypeError: bad\n  at h (a.js:1:1)",
        },
      ],
    }),
  );
  expect(thrown).toEqual(["03:04:05.006  ✗ TypeError: bad", "  at h (a.js:1:1)"]);
});

test("pretty: an event with a request indents its own console lines", () => {
  const lines = formatEvent(request({ logs: [{ level: "log", message: ["inside"], timestamp: 1 }] }));
  expect(lines[1]).toBe("  | inside");
});

function sse(frames: unknown[], comment = true): string {
  return (comment ? ": keepalive\n\n" : "") + frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

test("frames decode across chunk boundaries, skipping comments and junk", async () => {
  const text =
    sse([{ type: "ready" }, { type: "event", event: request() }, { type: "closed", reason: "cap" }]) +
    "data: {nope\n\n";
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readFrames(body)) frames.push(frame);
  expect(frames.map((frame) => frame.type)).toEqual(["ready", "event", "closed"]);
  const event = frames[1];
  expect(event.type === "event" && event.event.cpuTime).toBe(3.456);
});

async function withServer(
  handler: (request: Request, attempt: number) => Response,
  run: (url: string, seen: { key: string | null; url: string }[]) => Promise<void>,
) {
  const seen: { key: string | null; url: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push({ key: req.headers.get("x-api-key"), url: req.url });
      return handler(req, seen.length);
    },
  });
  try {
    await run(`http://127.0.0.1:${server.port}/api/projects/app/tail`, seen);
  } finally {
    server.stop(true);
  }
}

const sseResponse = (frames: unknown[]) =>
  new Response(sse(frames), { headers: { "content-type": "text/event-stream" } });

test("runTail prints NDJSON events only, notices on stderr, and reconnects after the server time cap", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  await withServer(
    (_req, attempt) =>
      attempt === 1
        ? sseResponse([
            { type: "ready" },
            { type: "event", event: request() },
            { type: "dropped", count: 7, reason: "rate" },
            { type: "closed", reason: "cap" },
          ])
        : sseResponse([{ type: "ready" }, { type: "event", event: request({ outcome: "exception" }) }]),
    async (url, seen) => {
      const done = runTail({
        url: `${url}?status=5xx`,
        headers: { "x-api-key": "k" },
        format: "json",
        signal: controller.signal,
        stdout: (text) => {
          out.push(text);
          if (out.length === 2) controller.abort();
        },
        stderr: (text) => err.push(text),
        retryMs: 5,
      });
      await done;
      expect(seen.length).toBeGreaterThanOrEqual(2); // reconnected
      expect(seen[0].key).toBe("k");
      expect(new URL(seen[0].url).searchParams.get("status")).toBe("5xx");
    },
  );
  expect(out.map((line) => JSON.parse(line).outcome)).toEqual(["ok", "exception"]);
  expect(err.join("")).toContain("7 events dropped");
});

test("runTail: a 4xx is final and names the server's reason; 404 explains old control planes", async () => {
  const run = async (status: number, body: string) => {
    let thrown: unknown;
    await withServer(
      () => new Response(body, { status }),
      async (url) => {
        thrown = await runTail({
          url,
          headers: {},
          format: "pretty",
          signal: new AbortController().signal,
          retryMs: 1,
        }).catch((e) => e);
      },
    );
    return thrown;
  };
  const bad = await run(400, JSON.stringify({ error: "sampling-rate must be a number from 0 to 1" }));
  expect(bad).toBeInstanceOf(TailError);
  expect(String(bad instanceof Error && bad.message)).toContain("sampling-rate must be");
  const missing = await run(404, "not found");
  expect(String(missing instanceof Error && missing.message)).toContain("--recent");
});

test("runTail retries a 5xx, then gives up after maxFailures", async () => {
  let attempts = 0;
  let thrown: unknown;
  await withServer(
    () => {
      attempts += 1;
      return new Response("down", { status: 503 });
    },
    async (url) => {
      thrown = await runTail({
        url,
        headers: {},
        format: "json",
        signal: new AbortController().signal,
        retryMs: 1,
        maxFailures: 3,
        stderr: () => {},
      }).catch((e) => e);
    },
  );
  expect(attempts).toBe(3);
  expect(String(thrown instanceof Error && thrown.message)).toContain("3 times in a row");
});

test("runTail reconnects when the server goes silent past idleMs", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await withServer(
    () => {
      attempts += 1;
      if (attempts === 1) {
        // Ready, then silence: the body never ends.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(sse([{ type: "ready" }])));
            },
          }),
        );
      }
      controller.abort();
      return sseResponse([{ type: "ready" }]);
    },
    async (url) => {
      await runTail({
        url,
        headers: {},
        format: "json",
        signal: controller.signal,
        idleMs: 60,
        retryMs: 1,
        stderr: () => {},
      });
    },
  );
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("sproutboat tail streams NDJSON through the real command and exits 0 on SIGINT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sb-tail-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.headers.get("x-api-key") !== "test-token") return new Response("unauthorized", { status: 401 });
      const url = new URL(req.url);
      if (url.pathname !== "/api/projects/tail-test/tail") return new Response("nope", { status: 404 });
      // Echo the filters back through the event so the test can see what the CLI sent.
      return sseResponse([{ type: "ready" }, { type: "event", event: request({ scriptName: url.search }) }]);
    },
  });
  try {
    await writeFile(
      join(directory, "sproutboat.jsonc"),
      JSON.stringify({ name: "tail-test", main: "src/missing-entry.js", compatibility_date: "2026-09-07" }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "main.ts"),
        "tail",
        directory,
        "--format",
        "json",
        "--status",
        "5xx",
        "--method",
        "get,post",
      ],
      {
        env: {
          ...process.env,
          SPROUTBOAT_API_URL: `http://127.0.0.1:${server.port}`,
          SPROUTBOAT_TOKEN: "test-token",
          SPROUTBOAT_NO_UPDATE_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(8000).then(() => {
        throw new Error("no event within 8s");
      }),
    ]);
    const line = new TextDecoder().decode(first.value).split("\n")[0];
    const event = JSON.parse(line);
    expect(event.outcome).toBe("ok");
    expect(new URLSearchParams(event.scriptName).getAll("status")).toEqual(["5xx"]);
    expect(new URLSearchParams(event.scriptName).getAll("method")).toEqual(["GET", "POST"]);
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
