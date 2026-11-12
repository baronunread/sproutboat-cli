import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./src/index";
import type { Env } from "./src/env";
import { LIMITS, clientKey, intParam } from "./src/guard";
import { REGIONS, extractRegions } from "./regions";

const HERE = import.meta.dir;

describe("code panels", () => {
  for (const [file, names] of Object.entries(REGIONS)) {
    test(`${file} has every region the page shows`, () => {
      const regions = extractRegions(readFileSync(join(HERE, file), "utf8"));
      for (const name of names) expect(regions.get(name)?.length ?? 0).toBeGreaterThan(20);
    });
  }

  test("a region is the text between its markers, trimmed", () => {
    const source = "a\n// #region x\nconst one = 1;\n\n// #endregion\nb";
    expect(extractRegions(source).get("x")).toBe("const one = 1;");
  });
});

describe("caps", () => {
  const url = (query: string) => new URL(`https://x.test/api/race?${query}`);

  test("intParam clamps to the range and falls back when missing or not a number", () => {
    expect(intParam(url("fans=100000"), "fans", 300, 1, LIMITS.maxFans)).toBe(500);
    expect(intParam(url("fans=-5"), "fans", 300, 1, 500)).toBe(1);
    expect(intParam(url("fans=abc"), "fans", 300, 1, 500)).toBe(300);
    expect(intParam(url(""), "fans", 300, 1, 500)).toBe(300);
    expect(intParam(url("fans=12.9"), "fans", 300, 1, 500)).toBe(12);
  });
});

describe("clientKey", () => {
  const request = (headers: HeadersInit, clientIp?: string) =>
    Object.assign(new Request("https://x.test/", { headers }), clientIp ? { cf: { clientIp } } : {});

  test("uses the peer address when it is public", () => {
    expect(clientKey(request({}, "203.0.113.9"))).toBe("203.0.113.9");
  });
  test("behind a private proxy it uses the last forwarded hop, never the first", () => {
    expect(clientKey(request({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }, "10.0.0.2"))).toBe("198.51.100.7");
  });
  test("with nothing usable it shares one bucket", () => {
    expect(clientKey(request({}, "127.0.0.1"))).toBe("shared");
  });
});

describe("the handler", () => {
  // The handler reads only env.ASSETS and ctx.waitUntil on these paths; the stubs are as small as that.
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- a test stub: the one cast, named, in one place.
  const stub = <T>(value: unknown): T => value as T;
  const env = stub<Env>({ ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } });
  const ctx = stub<ExecutionContext>({ waitUntil() {} });
  const call = (path: string, method = "GET") =>
    worker.fetch(stub(new Request(`https://x.test${path}`, { method })), env, ctx);

  test("/healthz answers without touching a binding", async () => {
    const response = await call("/healthz");
    expect(response.status).toBe(200);
    const body: { ok: boolean } = await response.json();
    expect(body.ok).toBe(true);
  });
  test("other paths go to the assets", async () => {
    expect(await (await call("/index.html")).text()).toBe("asset");
  });
  test("an unknown API route is a 404 with no internals", async () => {
    const response = await call("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
  test("a strategy that does not exist is refused before any binding is used", async () => {
    expect((await call("/api/race?strategy=drop-table", "POST")).status).toBe(404);
  });
});
