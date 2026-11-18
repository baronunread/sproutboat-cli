import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrelude, wrapNativeFetchHandler } from "./compile";
import { buildStandalone, emitStandalone, isReleaseBuild, unsupportedBindings } from "./standalone-build";
test("service bindings cannot work in a standalone binary", () => {
  // They call another deployment through an edge, and a standalone binary has
  // none — so this is a build error rather than a runtime surprise.
  const blocked = unsupportedBindings({ services: [{ binding: "AUTH", service: "auth-api" }] });
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toContain("edge");
});

test("a project with no bindings at all is fine", () => {
  expect(unsupportedBindings({})).toEqual([]);
});

test("standalone rejects service bindings before reading source or acquiring a compiler", async () => {
  await expect(
    buildStandalone({
      projectDir: "/does/not/exist",
      sourcePath: "/does/not/exist/handler.js",
      config: {
        name: "app",
        main: "handler.js",
        compatibility_date: "2026-08-26",
        services: [{ binding: "AUTH", service: "auth-api" }],
      },
    }),
  ).rejects.toThrow("service bindings call another deployment");
});

test("emit-only writes the standalone module where a full build does, acquiring nothing native", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sb-emit-standalone-"));
  const cache = await mkdtemp(join(tmpdir(), "sb-emit-cache-"));
  const saved = { zig: process.env.SPROUTBOAT_ZIG, cache: process.env.SPROUTBOAT_TOOLCHAIN_CACHE };
  // A missing Zig and an empty toolchain cache: any native acquisition would
  // throw or leave something behind.
  process.env.SPROUTBOAT_ZIG = join(cache, "no-such-zig");
  process.env.SPROUTBOAT_TOOLCHAIN_CACHE = cache;
  try {
    const source = `export default { fetch() { return new Response("hi"); } };`;
    const config = { name: "emit-app", main: "src/index.js", compatibility_date: "2026-10-01", vars: { G: "1" } };
    const { generatedPath } = await emitStandalone({
      projectDir,
      sourcePath: join(projectDir, "src/index.js"),
      source,
      config,
    });
    expect(generatedPath).toBe(
      join(projectDir, ".sproutboat/porffor-units/linux-x86_64-embedded-release/sprout.generated.js"),
    );
    // What buildArtifact derives for a project with no bindings; it carries vars
    // and resources beyond the Bindings type, so it is held in a variable.
    const bindings = {
      kv: [],
      secrets: [],
      d1: [],
      r2: [],
      queues: [],
      analytics: [],
      do: [],
      services: [],
      crons: [],
      ratelimiters: [],
      assets: "",
      vars: config.vars,
      resources: {},
    };
    const emitted = await readFile(generatedPath, "utf8");
    expect(emitted).toBe(
      wrapNativeFetchHandler(
        source,
        await loadPrelude("embedded"),
        config.vars,
        bindings,
        undefined,
        config.compatibility_date,
        config.name,
        undefined,
        "embedded",
        undefined,
        "auto",
      ),
    );
    expect(await readdir(cache)).toEqual([]);
    // No artifact directory and no binary copied out.
    expect(await readdir(join(projectDir, ".sproutboat"))).toEqual(["porffor-units"]);
    expect(await Bun.file(join(projectDir, "dist", config.name)).exists()).toBe(false);
  } finally {
    for (const [key, value] of [
      ["SPROUTBOAT_ZIG", saved.zig],
      ["SPROUTBOAT_TOOLCHAIN_CACHE", saved.cache],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("emit-only keeps the standalone build's checks", async () => {
  const config = { name: "app", main: "handler.js", compatibility_date: "2026-08-26" };
  await expect(
    emitStandalone({
      projectDir: "/does/not/exist",
      sourcePath: "/does/not/exist/handler.js",
      config: { ...config, services: [{ binding: "AUTH", service: "auth-api" }] },
    }),
  ).rejects.toThrow("service bindings call another deployment");
  await expect(
    emitStandalone({
      projectDir: "/does/not/exist",
      sourcePath: "/does/not/exist/handler.js",
      source: "export function fetch() {}",
      config,
    }),
  ).rejects.toThrow(/default-export an object/);
  await expect(
    emitStandalone({
      projectDir: "/does/not/exist",
      sourcePath: "/does/not/exist/handler.js",
      source: `export default { fetch() { return new Response("x"); } };`,
      config: { ...config, assets: { directory: "public" } },
    }),
  ).rejects.toThrow(/assets.directory "public" not found/);
});

test("--release and SPROUTBOAT_RELEASE choose the release build; the default is not", () => {
  expect(isReleaseBuild(["--standalone"], {})).toBe(false);
  expect(isReleaseBuild(["--standalone", "--release"], {})).toBe(true);
  expect(isReleaseBuild(["--release", "app"], {})).toBe(true);
  expect(isReleaseBuild([], { SPROUTBOAT_RELEASE: "1" })).toBe(true);
  expect(isReleaseBuild([], { SPROUTBOAT_RELEASE: "true" })).toBe(true);
  for (const off of ["", "0", "false", "FALSE"]) expect(isReleaseBuild([], { SPROUTBOAT_RELEASE: off })).toBe(false);
});

test("a Cloud emit keeps the assets settings but bakes no file into the module; a standalone emit still bakes them", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sb-emit-assets-"));
  try {
    const marker = "UNIQUE-ASSET-BYTES-0123456789";
    await Bun.write(join(projectDir, "site/index.html"), `<h1>${marker}</h1>${"x".repeat(2000)}`);
    const config = {
      name: "assets-app",
      main: "src/index.js",
      compatibility_date: "2026-10-01",
      assets: {
        directory: "site",
        binding: "ASSETS",
        not_found_handling: "404-page" as const,
        run_sprout_first: ["/api/*"],
      },
    };
    const input = {
      projectDir,
      sourcePath: join(projectDir, "src/index.js"),
      source: `export default { fetch(r, env) { return env.ASSETS.fetch(r); } };`,
      config,
    };
    const baked = await readFile((await emitStandalone(input)).generatedPath, "utf8");
    expect(baked).toContain(marker);
    const cloud = await readFile((await emitStandalone(input, { forCloud: true })).generatedPath, "utf8");
    expect(cloud).not.toContain(marker);
    expect(cloud).toContain("404-page");
    expect(cloud).toContain("/api/*");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
