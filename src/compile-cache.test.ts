import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCached } from "./compile-cache";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("concurrent identical builds publish one verified binary", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-compile-cache-"));
  temporary.push(root);
  let compiles = 0;
  const compile = async (path: string) => {
    compiles++;
    await Bun.sleep(30);
    await writeFile(path, "native binary");
  };
  const cache = resolve(root, "cache");
  const results = await Promise.all([
    compileCached(cache, "key", resolve(root, "first"), compile),
    compileCached(cache, "key", resolve(root, "second"), compile),
  ]);
  expect(results.sort()).toEqual(["hit", "miss"]);
  expect(compiles).toBe(1);
  expect(await readFile(resolve(root, "first"), "utf8")).toBe("native binary");
  expect(await readFile(resolve(root, "second"), "utf8")).toBe("native binary");
});

test("a damaged cache entry is rebuilt before it can be served", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-compile-cache-corrupt-"));
  temporary.push(root);
  let compiles = 0;
  const compile = async (path: string) => {
    compiles++;
    await writeFile(path, `binary ${compiles}`);
  };
  const cache = resolve(root, "cache");
  expect(await compileCached(cache, "key", resolve(root, "out"), compile)).toBe("miss");
  await rm(resolve(cache, "key", "sprout"));
  await writeFile(resolve(cache, "key", "sprout"), "damaged");
  expect(await compileCached(cache, "key", resolve(root, "out"), compile)).toBe("miss");
  expect(compiles).toBe(2);
  expect(await readFile(resolve(root, "out"), "utf8")).toBe("binary 2");
});
