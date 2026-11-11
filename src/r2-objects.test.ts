import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudTarget,
  communityTarget,
  deleteObject,
  getObject,
  metadataHeaders,
  parseObjectArgs,
  parseObjectPath,
  putObject,
  GET_USAGE,
  PUT_USAGE,
  type ObjectIo,
} from "./r2-objects";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-r2-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Stored = { bytes: Uint8Array<ArrayBuffer>; headers: Record<string, string> };
const objects = new Map<string, Stored>();
const seen: { method: string; path: string; auth: string | null; headers: Record<string, string> }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname,
      auth: request.headers.get("authorization") ?? request.headers.get("x-api-key"),
      headers: Object.fromEntries(request.headers),
    });
    const cloud = /^\/v1\/apps\/hello\/r2\/([^/]+)\/objects\/(.+)$/.exec(url.pathname);
    const community = /^\/api\/r2\/(r2_[0-9a-f]{24})\/objects\/(.+)$/.exec(url.pathname);
    if (cloud) {
      if (cloud[1] !== "FILES") return Response.json({ error: "no such bucket", reason: "no-bucket" }, { status: 404 });
      const key = decodeURIComponent(cloud[2]!);
      if (request.method === "PUT") {
        if (request.headers.get("x-force") === "denied")
          return Response.json({ error: "forbidden", need: "app:write" }, { status: 403 });
        objects.set(key, {
          bytes: new Uint8Array(await request.arrayBuffer()),
          headers: Object.fromEntries(request.headers),
        });
        return Response.json({ key, size: objects.get(key)!.bytes.length });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return Response.json({ key, deleted: true });
      }
      const found = objects.get(key);
      return found
        ? new Response(found.bytes)
        : Response.json({ error: "no such object", reason: "no-object" }, { status: 404 });
    }
    if (community) {
      if (request.method !== "GET") return new Response("not found", { status: 404 });
      const found = objects.get(decodeURIComponent(community[2]!));
      return found ? new Response(found.bytes) : Response.json({ error: "object not found" }, { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const url = `http://127.0.0.1:${server.port}`;

let out: Uint8Array[];
let notes: string[];
const io: ObjectIo = { log: () => {}, note: (line) => notes.push(line), stdout: { write: (bytes) => out.push(bytes) } };
beforeEach(() => {
  objects.clear();
  seen.length = 0;
  out = [];
  notes = [];
});
const cloud = cloudTarget(url, "sbk_token", "hello", "FILES");
const stdin = async () => new TextEncoder().encode("piped bytes");

describe("arguments", () => {
  test("the object path is bucket/key; the key may hold slashes", () => {
    expect(parseObjectPath("FILES/a/b c.txt", GET_USAGE)).toEqual({ bucket: "FILES", key: "a/b c.txt" });
    for (const bad of [undefined, "FILES", "FILES/", "/key"])
      expect(() => parseObjectPath(bad, GET_USAGE)).toThrow("<bucket>/<key>");
  });

  test("Wrangler's flags and their short forms", () => {
    const { positional, flags } = parseObjectArgs(
      [
        "FILES/a",
        "-f",
        "x.bin",
        "--ct",
        "image/png",
        "--cd=inline",
        "--ce",
        "gzip",
        "--cl",
        "en",
        "--cc",
        "max-age=60",
        "--expires",
        "2030-01-01",
        "--remote",
      ],
      PUT_USAGE,
    );
    expect(positional).toEqual(["FILES/a"]);
    expect(flags).toMatchObject({
      file: "x.bin",
      contentType: "image/png",
      contentDisposition: "inline",
      contentEncoding: "gzip",
      contentLanguage: "en",
      cacheControl: "max-age=60",
      expires: "2030-01-01",
    });
    expect(parseObjectArgs(["FILES/a", "-p"], PUT_USAGE).flags.pipe).toBe(true);
  });

  test("local mode and Basin-only flags are refused with a reason", () => {
    expect(() => parseObjectArgs(["FILES/a", "--local"], GET_USAGE)).toThrow(
      "--local is not supported for R2 objects yet",
    );
    expect(() => parseObjectArgs(["FILES/a", "-J", "eu"], GET_USAGE)).toThrow("-J is not supported");
    expect(() => parseObjectArgs(["FILES/a", "--wat"], GET_USAGE)).toThrow("unknown option --wat");
    expect(() => parseObjectArgs(["FILES/a", "--file"], GET_USAGE)).toThrow("--file needs a value");
  });

  test("metadata becomes the headers the Cloud route reads; the file's type is the default", () => {
    expect(
      metadataHeaders({ pipe: false, cacheControl: "no-cache", expires: "2030-01-01T00:00:00Z" }, "text/plain"),
    ).toEqual({
      "content-type": "text/plain",
      "x-object-cache-control": "no-cache",
      expires: "Tue, 01 Jan 2030 00:00:00 GMT",
    });
    expect(metadataHeaders({ pipe: false, contentType: "image/png" }, "text/plain")["content-type"]).toBe("image/png");
    expect(() => metadataHeaders({ pipe: false, expires: "never" }, undefined)).toThrow('"never" is not a date');
  });
});

describe("a Cloud app's bucket", () => {
  test("put from a file then get to a file, with the file's type and Wrangler's metadata flags", async () => {
    const dir = temp();
    writeFileSync(join(dir, "in.txt"), "hello r2");
    await putObject(cloud, "dir/in.txt", { pipe: false, file: "in.txt", cacheControl: "max-age=60" }, io, dir, stdin);
    const put = seen.find((call) => call.method === "PUT")!;
    expect(put.path).toBe("/v1/apps/hello/r2/FILES/objects/dir/in.txt");
    expect(put.auth).toBe("Bearer sbk_token");
    expect(put.headers["content-type"]).toBe("text/plain");
    expect(put.headers["x-object-cache-control"]).toBe("max-age=60");
    expect(notes[0]).toContain('Uploaded "dir/in.txt" to "FILES"');
    await getObject(cloud, "dir/in.txt", { pipe: false, file: "out/copy.txt" }, io, dir);
    expect(readFileSync(join(dir, "out/copy.txt"), "utf8")).toBe("hello r2");
  });

  test("get without --file writes ./<key> (Wrangler's default), --pipe writes the bytes to stdout", async () => {
    const dir = temp();
    objects.set("a/b.bin", { bytes: new Uint8Array([0, 255, 1]), headers: {} });
    await getObject(cloud, "a/b.bin", { pipe: false }, io, dir);
    expect([...readFileSync(join(dir, "a/b.bin"))]).toEqual([0, 255, 1]);
    await getObject(cloud, "a/b.bin", { pipe: true }, io, dir);
    expect([...out[0]!]).toEqual([0, 255, 1]);
    await expect(getObject(cloud, "a/b.bin", { pipe: true, file: "x" }, io, dir)).rejects.toThrow(
      "--file or --pipe, not both",
    );
  });

  test("put --pipe reads stdin; neither or both sources is a usage error", async () => {
    const dir = temp();
    await putObject(cloud, "p.txt", { pipe: true }, io, dir, stdin);
    expect(new TextDecoder().decode(objects.get("p.txt")!.bytes)).toBe("piped bytes");
    await expect(putObject(cloud, "p", { pipe: false }, io, dir, stdin)).rejects.toThrow("either --file or --pipe");
    await expect(putObject(cloud, "p", { pipe: true, file: "x" }, io, dir, stdin)).rejects.toThrow(
      "either --file or --pipe",
    );
    await expect(putObject(cloud, "p", { pipe: false, file: "missing.txt" }, io, dir, stdin)).rejects.toThrow(
      "missing.txt: no such file",
    );
  });

  test("keys with spaces and unicode are encoded per segment", async () => {
    const dir = temp();
    await putObject(cloud, "dir/é x.txt", { pipe: true }, io, dir, stdin);
    expect(seen[0]!.path).toBe("/v1/apps/hello/r2/FILES/objects/dir/%C3%A9%20x.txt");
    expect(objects.has("dir/é x.txt")).toBe(true);
  });

  test("delete is idempotent; a missing key and an unknown bucket say so", async () => {
    const dir = temp();
    objects.set("gone", { bytes: new Uint8Array(), headers: {} });
    await deleteObject(cloud, "gone", io);
    await deleteObject(cloud, "gone", io);
    expect(notes).toHaveLength(2);
    await expect(getObject(cloud, "nope", { pipe: true }, io, dir)).rejects.toThrow(
      "The specified key does not exist.",
    );
    await expect(getObject(cloudTarget(url, "t", "hello", "OTHER"), "k", { pipe: true }, io, dir)).rejects.toThrow(
      'no R2 bucket "OTHER" for hello',
    );
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });

  test("a file over 64 MiB is refused before any request", async () => {
    const dir = temp();
    writeFileSync(join(dir, "big"), new Uint8Array(64 * 1024 * 1024 + 1));
    await expect(putObject(cloud, "big", { pipe: false, file: "big" }, io, dir, stdin)).rejects.toThrow("64 MiB");
    expect(seen).toEqual([]);
  });
});

describe("self-hosted Community", () => {
  const community = communityTarget(url, "tok", "hello", "uploads", "r2_0123456789abcdef01234567");

  test("get reads through the existing route", async () => {
    objects.set("k.txt", { bytes: new TextEncoder().encode("community"), headers: {} });
    await getObject(community, "k.txt", { pipe: true }, io, temp());
    expect(new TextDecoder().decode(out[0]!)).toBe("community");
    expect(seen[0]!.auth).toBe("tok");
  });

  test("put and delete say Community cannot do them yet when the route answers 404", async () => {
    await expect(putObject(community, "k", { pipe: true }, io, temp(), stdin)).rejects.toThrow(
      "not supported on self-hosted Community yet",
    );
    await expect(deleteObject(community, "k", io)).rejects.toThrow("not supported on self-hosted Community yet");
  });
});
