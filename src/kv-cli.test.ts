import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
let mode: "normal" | "fail-second-page";
const batches: number[] = [];
const values = new Map([
  ["email:a@example.com", "first"],
  ["email:b@example.com", "second"],
  ["other", "ignored"],
]);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("x-api-key") !== "test-token") return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/api/kv")
      return Response.json({ resources: [{ id: "kv_0123456789abcdef01234567", name: "registrations" }] });
    if (url.pathname.endsWith("/keys")) {
      const cursor = url.searchParams.get("cursor");
      if (cursor && mode === "fail-second-page") return new Response("temporary failure", { status: 503 });
      if (!cursor) return Response.json({ keys: ["email:a@example.com"], cursor: "email:a@example.com" });
      return Response.json({ keys: ["email:b@example.com"], cursor: null });
    }
    if (url.pathname.endsWith("/bulk/get")) {
      // SAFETY: the CLI contract sends a JSON string array to this mock route.
      const keys = (await request.json()) as string[];
      batches.push(keys.length);
      return Response.json(keys.map((key) => ({ key, value: values.get(key) ?? null })));
    }
    if (url.pathname.endsWith("/bulk/put")) {
      // SAFETY: the CLI contract sends bulk-format entries to this mock route.
      const entries = (await request.json()) as Array<{ key: string; value: string }>;
      batches.push(entries.length);
      return Response.json({ written: entries.length, failures: [] });
    }
    if (url.pathname.includes("/keys/"))
      return Response.json({ key: decodeURIComponent(url.pathname.split("/keys/")[1]), value: "first" });
    return new Response("not found", { status: 404 });
  },
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sb-kv-cli-"));
});

beforeEach(() => {
  mode = "normal";
  batches.length = 0;
});

afterAll(async () => {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "src/main.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NO_COLOR: "1",
      SPROUTBOAT_API_URL: `http://127.0.0.1:${server.port}`,
      SPROUTBOAT_TOKEN: "test-token",
      SPROUTBOAT_NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

test("export follows cursors and commits a bulk-put-compatible file", async () => {
  const output = join(directory, "export.json");
  const result = await cli(["kv", "export", "registrations", "--prefix", "email:", "--output", output]);
  expect(result.code).toBe(0);
  expect(JSON.parse(await Bun.file(output).text())).toEqual([
    { key: "email:a@example.com", value: "first" },
    { key: "email:b@example.com", value: "second" },
  ]);
  expect(batches).toEqual([1, 1]);
});

test("a failed export leaves no destination or temporary file", async () => {
  mode = "fail-second-page";
  const output = join(directory, "failed.json");
  const result = await cli(["kv", "export", "registrations", "--output", output]);
  expect(result.code).toBe(1);
  expect(await Bun.file(output).exists()).toBe(false);
  expect((await readdir(directory)).some((name) => name.startsWith("failed.json.tmp-"))).toBe(false);
});

test("export refuses to replace an existing file without --force", async () => {
  const output = join(directory, "existing.json");
  await writeFile(output, "keep me");
  const result = await cli(["kv", "export", "registrations", "--output", output]);
  expect(result.code).toBe(1);
  expect(await Bun.file(output).text()).toBe("keep me");
  expect(result.stderr).toContain("already exists");
});

test("bulk put splits large input into bounded requests", async () => {
  const input = join(directory, "bulk.json");
  await writeFile(input, JSON.stringify(Array.from({ length: 205 }, (_, index) => ({ key: `k${index}`, value: "v" }))));
  const result = await cli(["kv", "bulk", "put", "registrations", input]);
  expect(result.code).toBe(0);
  expect(batches).toEqual([100, 100, 5]);
  expect(JSON.parse(result.stdout).written).toBe(205);
});

test("single get supports text and atomic file output", async () => {
  const text = await cli(["kv", "key", "get", "registrations", "email:a@example.com", "--text"]);
  expect(text.stdout).toBe("first\n");
  const output = join(directory, "value.txt");
  expect((await cli(["kv", "key", "get", "registrations", "email:a@example.com", "--output", output])).code).toBe(0);
  expect(await Bun.file(output).text()).toBe("first");
});
