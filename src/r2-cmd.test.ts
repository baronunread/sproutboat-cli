import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_KEY, startFakeCloud, type FakeOptions } from "./cloud-fake";
import { fakeLogin } from "./fake-login";
import type { JsonObject } from "./json";

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
        "cache-control": "max-age=60",
        expires: "Tue, 01 Jan 2030 00:00:00 GMT",
      });
      // The PUT declared its length, as the Cloud requires; nothing was chunked.
      expect(cloud.putRequests[0]?.headers["content-length"]).toBe("5");
      expect(cloud.putRequests[0]?.headers["transfer-encoding"]).toBeUndefined();
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

  test("a key without data:write may read but is told which grant it lacks and how to get it", async () => {
    await withCloud({ denyPermissions: ["data:write"] }, async (_cloud, env) => {
      const dir = project();
      writeFileSync(join(dir, "a.txt"), "x");
      const put = await cli(dir, ["r2", "object", "put", "FILES/a.txt", "--file", "a.txt"], env);
      expect(put.code).toBe(1);
      expect(put.stderr).toContain("lacks the data:write grant");
      expect(put.stderr).toContain("Deploy and data");
      const del = await cli(dir, ["r2", "object", "delete", "FILES/a.txt"], env);
      expect(del.stderr).toContain("lacks the data:write grant");
    });
    await withCloud({ denyPermissions: ["data:read"] }, async (_cloud, env) => {
      const get = await cli(project(), ["r2", "object", "get", "FILES/a.txt", "--pipe"], env);
      expect(get.code).toBe(1);
      expect(get.stderr).toContain("lacks the data:read grant");
      expect(get.stderr).toContain("Read data");
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

describe("the Cloud's final data contract", () => {
  test("a GET is an inert download: the object's own type comes from x-object-content-type, and an etag is quoted", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      writeFileSync(join(dir, "pic.png"), new Uint8Array([137, 80, 78, 71]));
      const put = await cli(dir, ["r2", "object", "put", "FILES/pic.png", "--file", "pic.png"], env);
      expect(put.code, put.stderr).toBe(0);
      expect(put.stderr).toMatch(/etag "[0-9a-f]{32}"/);
      const response = await fetch(`${cloud.url}/v1/apps/hello/r2/FILES/objects/pic.png`, {
        headers: { authorization: `Bearer ${FAKE_KEY}` },
      });
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      expect(response.headers.get("x-object-content-type")).toBe("image/png");
      const get = await cli(dir, ["r2", "object", "get", "FILES/pic.png", "-f", "got.png"], env);
      expect(get.stderr).toContain("image/png");
      expect(get.stderr).not.toContain("octet-stream");
      expect([...readFileSync(join(dir, "got.png"))]).toEqual([137, 80, 78, 71]);
      // Stored without a type: the Cloud sends no x-object-content-type, and nothing is invented.
      const piped = await cli(dir, ["r2", "object", "put", "FILES/raw", "--pipe"], env, new Uint8Array([1, 2]));
      expect(piped.code).toBe(0);
      expect(cloud.objects.get("FILES/raw")?.headers["content-type"]).toBeUndefined();
      const raw = await cli(dir, ["r2", "object", "get", "FILES/raw", "-f", "raw.bin"], env);
      expect(raw.stderr).not.toContain("octet-stream");
      expect(raw.stderr).toContain("(2 bytes)");
    });
  });

  test("a bad key is refused with a reason before anything is sent", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      const cases: [string, string][] = [
        ["FILES/a//b", "empty segment"],
        ["FILES/a/../b", '".." segment'],
        ["FILES/./a", '"." segment'],
        ["FILES/a\\b", "backslash"],
        ["FILES/a\u0085b", "U+0085"],
        [`FILES/${"k".repeat(1025)}`, "1025 bytes"],
      ];
      for (const [path, words] of cases)
        for (const verb of ["get", "put", "delete"]) {
          const run = await cli(dir, ["r2", "object", verb, path, "--pipe"], env, new Uint8Array([1]));
          expect(run.code, `${verb} ${path}`).toBe(2);
          expect(run.stderr).toContain(words);
        }
      expect(cloud.calls.filter((call) => call.path.includes("/r2/"))).toEqual([]);
    });
  });

  const failures: [string, string, number, JsonObject, string, Record<string, string>?][] = [
    ["get", "a rate limit says when to retry", 429, { error: "x", reason: "rate", retry_after: 3 }, "try again in 3 s"],
    [
      "put",
      "a busy host reads retry-after from the header",
      503,
      { error: "x", reason: "busy" },
      "try again in 7 s",
      { "retry-after": "7" },
    ],
    [
      "get",
      "an unavailable host says remote R2 isn't there yet",
      503,
      { error: "x", reason: "host-unavailable" },
      "remote D1/R2 isn't available on this Cloud host yet",
    ],
    [
      "put",
      "a failed audit says the request was not served",
      503,
      { error: "x", reason: "audit-unavailable" },
      "read before retrying",
    ],
    [
      "delete",
      "an agent error says remote R2 isn't there yet",
      502,
      { error: "x", reason: "agent-error" },
      "remote D1/R2 isn't available on this Cloud host yet",
    ],
    [
      "get",
      "a bare 503 says remote R2 isn't there yet",
      503,
      {},
      "remote D1/R2 isn't available on this Cloud host yet",
    ],
    [
      "put",
      "a backup capture says writes are paused",
      409,
      { error: "x", reason: "capture-active" },
      "writes are paused while a backup capture is active",
    ],
    ["put", "a full quota says so", 507, { error: "x", reason: "quota-exceeded" }, "quota exceeded"],
    ["put", "a missing length is explained", 411, { error: "x", reason: "length-required" }, "length up front"],
    ["put", "a too-large object names the limit", 413, { error: "too large", reason: "too-large" }, "at most 64 MiB"],
    [
      "put",
      "a body that does not match its length names the body",
      400,
      { error: "the body ran past its length", reason: "invalid", path: "body" },
      "(body)",
    ],
    ["get", "a timeout says the host did not answer", 504, { error: "x", reason: "timeout" }, "did not answer in time"],
  ];
  for (const [verb, title, status, body, expected, headers] of failures)
    test(`${verb}: ${title}`, async () => {
      await withCloud({ dataFailure: { status, body, headers } }, async (_cloud, env) => {
        const dir = project();
        const args = ["r2", "object", verb, "FILES/a.txt", ...(verb === "put" ? ["--pipe"] : ["--pipe"])];
        const run = await cli(dir, args, env, new Uint8Array([1]));
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(expected);
        expect(run.stderr).not.toContain("HTTP");
      });
    });
});

describe("global flags and unknown options", () => {
  test("--profile, -c and --cwd work for object commands", async () => {
    const cloud = startFakeCloud({ appExists: true, r2: ["FILES"] });
    const login = fakeLogin(cloud.url);
    roots.push(login.dir);
    const dir = project();
    const elsewhere = mkdtempSync(join(tmpdir(), "sb-r2-elsewhere-"));
    roots.push(elsewhere);
    writeFileSync(join(dir, "n.txt"), "hello");
    try {
      const put = await cli(
        dir,
        ["r2", "object", "put", "FILES/n.txt", "-f", "n.txt", "--profile", login.profile],
        login.env,
      );
      expect(put.code, put.stderr).toBe(0);
      const config = join(dir, "sproutboat.jsonc");
      for (const args of [
        ["--profile", login.profile, "-c", config, "r2", "object", "get", "FILES/n.txt", "--pipe"],
        ["r2", "object", "get", "FILES/n.txt", "--pipe", `--profile=${login.profile}`, "-c", config],
        ["r2", "object", "get", "FILES/n.txt", "--pipe", "--profile", login.profile, "--cwd", dir],
      ]) {
        const run = await cli(elsewhere, args, login.env);
        expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(0);
        expect(run.text).toBe("hello");
      }
      // Without a profile the decoy default is used, so nothing reaches the Cloud.
      expect((await cli(dir, ["r2", "object", "get", "FILES/n.txt", "--pipe"], login.env)).code).toBe(1);
    } finally {
      cloud.stop();
    }
  });

  test("an unknown option is refused with exit 2", async () => {
    await withCloud({}, async (cloud, env) => {
      const dir = project();
      for (const args of [
        ["r2", "object", "get", "FILES/a", "--pipe", "--follow"],
        ["r2", "object", "put", "FILES/a", "--pipe", "--cotnent-type", "x"],
        ["r2", "object", "delete", "FILES/a", "--force"],
      ]) {
        const run = await cli(dir, args, env, new Uint8Array([1]));
        expect(run.code, args.join(" ")).toBe(2);
        expect(run.stderr).toContain("unknown option");
      }
      expect(cloud.calls.filter((call) => call.path.includes("/r2/"))).toEqual([]);
    });
  });
});
