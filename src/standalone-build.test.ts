import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrelude, wrapNativeFetchHandler } from "./compile";
import type { BuildInput } from "./build";
import { parseConfig } from "./config";
import {
  assetBakeWarning,
  buildStandalone,
  describeAssetBake,
  emitStandalone,
  isReleaseBuild,
  MODULE_STATIC_BASE,
  MODULE_STATIC_LIMIT,
  MODULE_STATIC_MARGIN,
  planAssetBake,
  unsupportedBindings,
  workerReadsAssets,
} from "./standalone-build";
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

test("workerReadsAssets: a binding, run_sprout_first true or a non-empty route list; nothing else", () => {
  const dir = { directory: "site" };
  expect(workerReadsAssets(undefined)).toBe(false);
  expect(workerReadsAssets(dir)).toBe(false);
  expect(workerReadsAssets({ ...dir, not_found_handling: "404-page" })).toBe(false);
  expect(workerReadsAssets({ ...dir, run_sprout_first: false })).toBe(false);
  expect(workerReadsAssets({ ...dir, run_sprout_first: [] })).toBe(false);
  expect(workerReadsAssets({ ...dir, binding: "ASSETS" })).toBe(true);
  expect(workerReadsAssets({ ...dir, run_sprout_first: true })).toBe(true);
  expect(workerReadsAssets({ ...dir, run_sprout_first: ["/api/*"] })).toBe(true);
  expect(workerReadsAssets({ ...dir, binding: "ASSETS", run_sprout_first: false })).toBe(true);
});

/** Emit a one-file assets project and return the module source of a standalone emit and of a Cloud emit. */
async function emitBoth(assets: Partial<NonNullable<BuildInput["config"]["assets"]>>) {
  const projectDir = await mkdtemp(join(tmpdir(), "sb-emit-assets-"));
  try {
    const marker = "UNIQUE-ASSET-BYTES-0123456789";
    await Bun.write(join(projectDir, "site/index.html"), `<h1>${marker}</h1>${"x".repeat(2000)}`);
    const input = {
      projectDir,
      sourcePath: join(projectDir, "src/index.js"),
      source: `export default { fetch(r, env) { return env.ASSETS.fetch(r); } };`,
      config: {
        name: "assets-app",
        main: "src/index.js",
        compatibility_date: "2026-10-01",
        assets: { directory: "site", ...assets },
      },
    };
    const standalone = await readFile((await emitStandalone(input)).generatedPath, "utf8");
    const cloud = await readFile((await emitStandalone(input, { forCloud: true })).generatedPath, "utf8");
    return { marker, standalone, cloud };
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

test("a Cloud emit of an app with no binding and no worker-first route keeps the settings and bakes no file", async () => {
  const { marker, standalone, cloud } = await emitBoth({ not_found_handling: "404-page" });
  expect(standalone).toContain(marker);
  expect(cloud).not.toContain(marker);
  expect(cloud).toContain("404-page");
});

test("a Cloud emit bakes the files in when the worker can read them: a binding, or run_sprout_first (boolean or routes)", async () => {
  const workerFirstConfigs: Parameters<typeof emitBoth>[0][] = [
    { binding: "ASSETS" },
    { run_sprout_first: true },
    { run_sprout_first: ["/api/*"] },
    // the kitchen-sink shape (dogfood/kitchen-sink/sproutboat.jsonc)
    { binding: "ASSETS", not_found_handling: "single-page-application", run_sprout_first: true },
  ];
  for (const assets of workerFirstConfigs) {
    const { marker, cloud } = await emitBoth(assets);
    expect(cloud, JSON.stringify(assets)).toContain(marker);
  }
});

test("the real kitchen-sink config (worker-first, with a binding) gets its assets embedded in a Cloud emit", async () => {
  const dir = join(import.meta.dir, "../dogfood/kitchen-sink");
  const parsed = parseConfig(await readFile(join(dir, "sproutboat.jsonc"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const { assets } = parsed.value;
  expect(assets).toMatchObject({ binding: "ASSETS", run_sprout_first: true });
  expect(workerReadsAssets(assets)).toBe(true);
  // the Cloud emit of this very config, over a stand-in site directory
  const projectDir = await mkdtemp(join(tmpdir(), "sb-ks-assets-"));
  try {
    const marker = "KITCHEN-SINK-PAGE-BYTES-0123456789";
    await Bun.write(join(projectDir, "site/index.html"), `<h1>${marker}</h1>`);
    const { generatedPath } = await emitStandalone(
      {
        projectDir,
        sourcePath: join(projectDir, "src/index.js"),
        source: `export default { fetch(r, env) { return env.ASSETS.fetch(r); } };`,
        config: { ...parsed.value, services: [] },
      },
      { forCloud: true },
    );
    expect(await readFile(generatedPath, "utf8")).toContain(marker);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

// Size of a Cloud emit's module, the worker's own source and what the bake decision measured, for a one-file site of `bytes` bytes.
async function bakeCase(
  bytes: number,
  assets: Partial<NonNullable<BuildInput["config"]["assets"]>> = { binding: "ASSETS" },
) {
  const projectDir = await mkdtemp(join(tmpdir(), "sb-bake-fit-"));
  try {
    await Bun.write(join(projectDir, "site/big.bin"), new Uint8Array(bytes).fill(0x41));
    const input = {
      projectDir,
      sourcePath: join(projectDir, "src/index.js"),
      source: `export default { fetch(r, env) { return env.ASSETS.fetch(r); } };`,
      config: {
        name: "big-site",
        main: "src/index.js",
        compatibility_date: "2026-10-01",
        assets: { directory: "site", ...assets },
      },
    };
    const emitted = await emitStandalone(input, { forCloud: true });
    return { input, emitted, module: await readFile(emitted.generatedPath, "utf8") };
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const OWN_SOURCE = `export default { fetch(r, env) { return env.ASSETS.fetch(r); } };`.length + "{}".length;
const BUDGET = MODULE_STATIC_LIMIT - MODULE_STATIC_MARGIN - MODULE_STATIC_BASE - OWN_SOURCE;
// one file "/big.bin": its bytes, its key, the per-file cost and the empty _headers/_redirects lists
const ONE_FILE_COST = "/big.bin".length + 88 + JSON.stringify([[], []]).length;

test("assets over the module's static data limit are left out of a Cloud emit, with a warning that says so", async () => {
  // the sproutboat.com shape: 1.1 MB of files, a binding
  const { emitted, module } = await bakeCase(1_100_000);
  expect(emitted.assetBake).toMatchObject({ reads: true, bake: false, files: 1 });
  expect(emitted.assetBake!.overBy).toBe(1_100_000 + ONE_FILE_COST - BUDGET);
  expect(module).not.toContain("A".repeat(1000));
  // the settings stay, as in 0.58.0
  expect(module).toContain("__sbAssets");
  const warning = assetBakeWarning(emitted.assetBake!)!;
  expect(warning).toContain("env.ASSETS.fetch inside the worker will not find these files");
  expect(warning).toContain(`${emitted.assetBake!.overBy.toLocaleString("en-US")} bytes over the limit`);
  expect(describeAssetBake(emitted.assetBake!)).toContain(
    `${emitted.assetBake!.overBy.toLocaleString("en-US")} bytes over`,
  );
});

test("small assets of a worker that reads them are still baked into a Cloud emit, and the line says it fits", async () => {
  const { emitted, module } = await bakeCase(2000);
  expect(emitted.assetBake).toMatchObject({ reads: true, bake: true, overBy: 0 });
  expect(module).toContain("A".repeat(2000));
  expect(assetBakeWarning(emitted.assetBake!)).toBeUndefined();
  expect(describeAssetBake(emitted.assetBake!)).toContain("kept in the module");
  expect(describeAssetBake(emitted.assetBake!)).toContain("fits");
});

test("the bake boundary: the last byte that fits is baked, one more is not", async () => {
  const fit = await bakeCase(BUDGET - ONE_FILE_COST);
  expect(fit.emitted.assetBake).toMatchObject({ bake: true, overBy: 0, bakedBytes: BUDGET });
  expect(fit.module).toContain("A".repeat(10_000));
  const over = await bakeCase(BUDGET - ONE_FILE_COST + 1);
  expect(over.emitted.assetBake).toMatchObject({ bake: false, overBy: 1 });
  expect(over.module).not.toContain("A".repeat(10_000));
});

test("the limit keeps a margin below the linker's 1 MiB, and the worker's own source counts against it", () => {
  expect(MODULE_STATIC_LIMIT).toBe(1_048_576);
  expect(MODULE_STATIC_LIMIT - MODULE_STATIC_MARGIN - MODULE_STATIC_BASE).toBeLessThan(MODULE_STATIC_LIMIT - 126_080);
  const base = {
    name: "a",
    main: "src/index.js",
    compatibility_date: "2026-10-01",
    assets: { directory: "site", binding: "ASSETS" },
  };
  const dir = mkdtempSync(join(tmpdir(), "sb-bake-own-"));
  try {
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site/a.txt"), "x");
    const plain = planAssetBake({ projectDir: dir, sourcePath: "x", source: "", config: base });
    const big = planAssetBake({ projectDir: dir, sourcePath: "x", source: "s".repeat(200_000), config: base });
    expect(plain.budget - big.budget).toBe(200_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker that does not read its assets plans no bake and no warning, however big the files", async () => {
  const { emitted, module } = await bakeCase(1_100_000, { not_found_handling: "404-page" });
  expect(emitted.assetBake).toMatchObject({ reads: false, bake: false });
  expect(assetBakeWarning(emitted.assetBake!)).toBeUndefined();
  expect(describeAssetBake(emitted.assetBake!)).toContain("does not read env.ASSETS");
  expect(module).not.toContain("A".repeat(1000));
});

test("planAssetBake counts the worker file when no source string is passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-bake-src-"));
  try {
    mkdirSync(join(dir, "site"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "site/a.txt"), "x");
    writeFileSync(join(dir, "src/index.js"), "s".repeat(50_000));
    const config = {
      name: "a",
      main: "src/index.js",
      compatibility_date: "2026-10-01",
      assets: { directory: "site", binding: "ASSETS" },
    };
    const fromFile = planAssetBake({ projectDir: dir, sourcePath: join(dir, "src/index.js"), config });
    const given = planAssetBake({
      projectDir: dir,
      sourcePath: join(dir, "src/index.js"),
      source: "s".repeat(50_000),
      config,
    });
    expect(fromFile.budget).toBe(given.budget);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planAssetBake counts the worker's source in UTF-8 bytes, so a CJK literal takes its full size", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-bake-utf8-"));
  try {
    mkdirSync(join(dir, "site"));
    writeFileSync(join(dir, "site/a.txt"), "x");
    const config = {
      name: "a",
      main: "src/index.js",
      compatibility_date: "2026-10-01",
      assets: { directory: "site", binding: "ASSETS" },
    };
    const ascii = planAssetBake({ projectDir: dir, sourcePath: "x", source: "s".repeat(1000), config });
    const cjk = planAssetBake({ projectDir: dir, sourcePath: "x", source: "文".repeat(1000), config });
    expect(ascii.budget - cjk.budget).toBe(2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
