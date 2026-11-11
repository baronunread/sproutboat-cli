import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY, startFakeCloud, type FakeOptions } from "./cloud-fake";

const MAIN = join(import.meta.dir, "main.ts");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(extra = `"r2_buckets": ["FILES"]`): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-r2-cmd-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "sproutboat.jsonc"),
    `{ "name": "hello", "main": "src/index.js", "compatibility_date": "2026-09-07", ${extra} }`,
  );
  return dir;
}

async function cli(dir: string, args: string[], env: Record<string, string>, stdin?: Uint8Array<ArrayBuffer>) {
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      SPROUTBOAT_NO_UPDATE_CHECK: "1",
      SPROUTBOAT_API_TOKEN: "",
      SPROUTBOAT_TOKEN: "",
      ...env,
    },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: new Uint8Array(stdout), text: new TextDecoder().decode(stdout), stderr };
}

async function withCloud(
  options: FakeOptions,
  run: (cloud: ReturnType<typeof startFakeCloud>, env: Record<string, string>) => Promise<void>,
) {
  const cloud = startFakeCloud({ appExists: true, r2: ["FILES"], ...options });
  try {
    await run(cloud, { SPROUTBOAT_API_URL: cloud.url, SPROUTBOAT_API_TOKEN: FAKE_KEY });
  } finally {
    cloud.stop();
  }
}

describe("r2 object on a Cloud endpoint", () => {
  test("put from a file with metadata flags, get to a file, get --pipe, delete", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      writeFileSync(join(dir, "pic.bin"), new Uint8Array([0, 1, 2, 254, 255]));
      const put = await cli(
        dir,
        [
          "r2",
          "object",
          "put",
          "FILES/img/pic.bin",
          "--file",
          "pic.bin",
          "--ct",
          "image/png",
          "--cc",
          "max-age=60",
          "--expires",
          "2030-01-01T00:00:00Z",
        ],
        env,
      );
      expect(put.code).toBe(0);
      expect(put.stderr).toContain('Uploaded "img/pic.bin" to "FILES"');
      expect(cloud.objects.get("FILES/img/pic.bin")?.headers).toMatchObject({
        "content-type": "image/png",
        "x-object-cache-control": "max-age=60",
        expires: "Tue, 01 Jan 2030 00:00:00 GMT",
      });
      const get = await cli(dir, ["r2", "object", "get", "FILES/img/pic.bin", "-f", "out/copy.bin"], env);
      expect(get.code).toBe(0);
      expect([...readFileSync(join(dir, "out/copy.bin"))]).toEqual([0, 1, 2, 254, 255]);
      // No --file: the key is the path (Wrangler's default).
      expect((await cli(dir, ["r2", "object", "get", "FILES/img/pic.bin"], env)).code).toBe(0);
      expect(existsSync(join(dir, "img/pic.bin"))).toBe(true);
      const piped = await cli(dir, ["r2", "object", "get", "FILES/img/pic.bin", "--pipe"], env);
      expect([...piped.stdout]).toEqual([0, 1, 2, 254, 255]);
      expect((await cli(dir, ["r2", "object", "delete", "FILES/img/pic.bin"], env)).code).toBe(0);
      expect(cloud.objects.size).toBe(0);
      const gone = await cli(dir, ["r2", "object", "get", "FILES/img/pic.bin", "--pipe"], env);
      expect(gone.code).toBe(1);
      expect(gone.stderr).toContain("The specified key does not exist.");
    });
  });

  test("put --pipe reads stdin", async () => {
    await withCloud({}, async (cloud, env) => {
      const run = await cli(
        project(),
        ["r2", "object", "put", "FILES/note.txt", "--pipe", "--content-type", "text/plain"],
        env,
        new TextEncoder().encode("from stdin"),
      );
      expect(run.code).toBe(0);
      expect(new TextDecoder().decode(cloud.objects.get("FILES/note.txt")?.bytes)).toBe("from stdin");
    });
  });

  test("usage mistakes: path shape, a missing source, local mode, an unknown bucket", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      expect((await cli(dir, ["r2", "object", "get", "FILES"], env)).code).toBe(2);
      expect((await cli(dir, ["r2", "object", "put", "FILES/a"], env)).stderr).toContain("either --file or --pipe");
      expect((await cli(dir, ["r2", "object", "get", "FILES/a", "--local"], env)).stderr).toContain(
        "--local is not supported for R2 objects yet",
      );
      expect((await cli(dir, ["r2", "object", "wat"], env)).code).toBe(2);
      const unknown = await cli(dir, ["r2", "object", "get", "OTHER/a", "--pipe"], env);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('no R2 binding "OTHER" in sproutboat.jsonc (it has: FILES)');
      expect(
        (await cli(project(`"d1_databases": ["DB"]`), ["r2", "object", "get", "FILES/a", "--pipe"], env)).stderr,
      ).toContain("has no r2_buckets");
      expect(cloud.calls.filter((c) => c.path.includes("/r2/"))).toEqual([]);
    });
  });

  test("a read-only key may read but is told it needs app:write to write; an undeployed app says so", async () => {
    await withCloud({ denyPermissions: ["app:write"] }, async (_cloud, env) => {
      const dir = project();
      writeFileSync(join(dir, "a.txt"), "x");
      const put = await cli(dir, ["r2", "object", "put", "FILES/a.txt", "--file", "a.txt"], env);
      expect(put.code).toBe(1);
      expect(put.stderr).toContain("app:write");
    });
    await withCloud({ appExists: false }, async (_cloud, env) => {
      const run = await cli(project(), ["r2", "object", "get", "FILES/a", "--pipe"], env);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("hello is not deployed yet");
    });
  });
});

describe("r2 object on self-hosted Community", () => {
  test("get reads through the existing route; put and delete are not supported yet", async () => {
    const stored = new Map<string, string>([["a/b.txt", "community bytes"]]);
    const id = "r2_0123456789abcdef01234567";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/r2" && request.method === "GET")
          return Response.json({ resources: [{ id, name: "uploads" }] });
        const object = new RegExp(`^/api/r2/${id}/objects/(.+)$`).exec(url.pathname);
        if (object && request.method === "GET") {
          const value = stored.get(decodeURIComponent(object[1]!));
          return value === undefined
            ? Response.json({ error: "object not found" }, { status: 404 })
            : new Response(value);
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const env = { SPROUTBOAT_API_URL: `http://127.0.0.1:${server.port}`, SPROUTBOAT_TOKEN: "tok" };
      const dir = project(`"r2_buckets": ["UPLOADS"]`);
      const get = await cli(dir, ["r2", "object", "get", "uploads/a/b.txt", "--pipe"], env);
      expect(get.code).toBe(0);
      expect(get.text).toBe("community bytes");
      writeFileSync(join(dir, "x.txt"), "x");
      const put = await cli(dir, ["r2", "object", "put", "uploads/a/b.txt", "--file", "x.txt"], env);
      expect(put.code).toBe(1);
      expect(put.stderr).toContain("not supported on self-hosted Community yet");
      const del = await cli(dir, ["r2", "object", "delete", "uploads/a/b.txt"], env);
      expect(del.code).toBe(1);
      expect(del.stderr).toContain("not supported on self-hosted Community yet");
      const nobucket = await cli(dir, ["r2", "object", "get", "nope/a", "--pipe"], env);
      expect(nobucket.code).toBe(1);
      expect(nobucket.stderr).toContain('no bucket named "nope"');
    } finally {
      server.stop(true);
    }
  });
});
