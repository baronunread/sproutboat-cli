import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensureZig, inspectToolchain, ZIG_VERSION, ZigToolchainError } from "./toolchain";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ archive: string; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "sb-zig-fixture-"));
  temporary.push(root);
  const source = join(root, `zig-x86_64-linux-${ZIG_VERSION}`);
  await mkdir(source);
  await writeFile(join(source, "zig"), "#!/bin/sh\necho fixture zig\n");
  const archive = join(root, "zig.tar.xz");
  const tar = Bun.spawn(["tar", "-cJf", archive, "-C", root, basename(source)], { stderr: "pipe" });
  const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (code !== 0) throw new Error(`could not create fixture: ${stderr}`);
  return {
    archive,
    sha256: createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
  };
}

test("Zig acquisition is atomic, shared concurrently, and warm-cache offline", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-zig-cache-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const options = {
    cacheRoot,
    platform: "x86_64-linux" as const,
    url: "fixture",
    expectedSha256: sha256,
    validate: false,
    fetcher: async () => {
      requests += 1;
      await Bun.sleep(5);
      return new Response(Bun.file(archive));
    },
  };
  const bins = await Promise.all(Array.from({ length: 8 }, () => ensureZig(options)));
  expect(new Set(bins).size).toBe(1);
  expect(requests).toBe(1);
  expect((await readdir(cacheRoot)).filter((name) => name.startsWith(".zig-"))).toEqual([]);
  await ensureZig({
    ...options,
    fetcher: async () => {
      throw new Error("offline fetch must not run");
    },
  });
});

test("a corrupt Zig cache is replaced from the verified archive", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-zig-corrupt-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const options = {
    cacheRoot,
    platform: "x86_64-linux" as const,
    url: "fixture",
    expectedSha256: sha256,
    validate: false,
    fetcher: async () => {
      requests += 1;
      return new Response(Bun.file(archive));
    },
  };
  const bin = await ensureZig(options);
  await writeFile(bin, "corrupt");
  await ensureZig(options);
  expect(requests).toBe(2);
  expect(await readFile(bin, "utf8")).toContain("fixture zig");
});

test("Zig integrity and download failures publish no cache entry", async () => {
  const { archive } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-zig-failure-"));
  temporary.push(cacheRoot);
  const integrity = await ensureZig({
    cacheRoot,
    platform: "x86_64-linux",
    url: "fixture",
    expectedSha256: "0".repeat(64),
    fetcher: async () => new Response(Bun.file(archive)),
  }).catch((cause: unknown) => cause);
  expect(integrity).toBeInstanceOf(ZigToolchainError);
  if (!(integrity instanceof ZigToolchainError)) throw integrity;
  expect(integrity.kind).toBe("integrity");
  let attempts = 0;
  const download = await ensureZig({
    cacheRoot,
    platform: "x86_64-linux",
    url: "fixture",
    fetcher: async () => {
      attempts += 1;
      throw new Error("offline");
    },
  }).catch((cause: unknown) => cause);
  expect(download).toBeInstanceOf(ZigToolchainError);
  if (!(download instanceof ZigToolchainError)) throw download;
  expect(download.kind).toBe("download");
  expect(attempts).toBe(2);
  expect(await readdir(cacheRoot)).toEqual([]);
});

test("an unusable pinned Zig is classified before it can publish a cache", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-zig-compiler-"));
  temporary.push(cacheRoot);
  const error = await ensureZig({
    cacheRoot,
    platform: "x86_64-linux",
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => new Response(Bun.file(archive)),
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ZigToolchainError);
  if (!(error instanceof ZigToolchainError)) throw error;
  expect(error.kind).toBe("compiler");
  expect((await readdir(cacheRoot)).some((name) => name.startsWith("zig-"))).toBe(false);
});

test("an interrupted Zig lock is recovered", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-zig-lock-"));
  temporary.push(cacheRoot);
  const lock = join(cacheRoot, `zig-${ZIG_VERSION}-x86_64-linux.lock`);
  await mkdir(lock);
  const stale = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, stale, stale);
  const bin = await ensureZig({
    cacheRoot,
    platform: "x86_64-linux",
    url: "fixture",
    expectedSha256: sha256,
    validate: false,
    fetcher: async () => new Response(Bun.file(archive)),
  });
  expect(await readFile(bin, "utf8")).toContain("fixture zig");
  expect((await readdir(cacheRoot)).some((name) => name.endsWith(".lock"))).toBe(false);
});

test("toolchain doctor inspection is non-mutating and identifies every managed cache", () => {
  const report = inspectToolchain();
  expect(report.host).toBe(`${process.arch}/${process.platform}`);
  expect(report.porffor.version).toContain("alpha-4");
  expect(report.zig.version).toBe(ZIG_VERSION);
  expect(report.sqlite.path).toContain("sqlite-");
  expect(report.bearssl.path).toContain("bearssl-");
  expect(report.prerequisites.tar).not.toBeUndefined();
});
