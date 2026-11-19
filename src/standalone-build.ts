/**
 * #15 — `sproutboat build --standalone`.
 *
 * Emits ONE executable carrying the compiled sprout, its static assets and its
 * binding declarations, with SQLite linked in so there is no broker and no
 * second process. The build is thin on purpose: `buildArtifact` with the
 * embedded transport already produces exactly the binary we want, so this
 * copies it out and enforces the one thing a standalone binary cannot do.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readAssetRules, walkAssets } from "./assets";
import { buildArtifact, emitGenerated, type BuildInput } from "./build";
import type { Bindings } from "./wrap";

export type StandaloneBuildInput = BuildInput & {
  /** Where to write the executable. Defaults to `<projectDir>/dist/<name>`. */
  outPath?: string;
  /**
   * The release build: `-flto -O3`, the binary to publish. Off by default: units still compile at -O3 but
   * the link skips LTO, which is 1.5 to 2x faster cold and links in ~90 MB instead of 1.1 to 1.6 GB, at some
   * request throughput (docs/standalone.md, "Dev and release builds").
   */
  release?: boolean;
};

/** `--release` or `SPROUTBOAT_RELEASE=1` (`0`, empty or unset: not a release build). */
export function isReleaseBuild(args: string[], env: Record<string, string | undefined> = process.env): boolean {
  if (args.includes("--release")) return true;
  const value = env.SPROUTBOAT_RELEASE;
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export type StandaloneBuildResult = { outPath: string; bytes: number };

/**
 * Bindings a standalone binary cannot serve.
 *
 * A build error, not a runtime no-op: a binary whose binding silently does
 * nothing is discovered in production, on a device someone has to reach
 * physically.
 *
 * Outbound `fetch` is absent from this list: http and https both work, with
 * BearSSL and the Mozilla root set compiled in.
 */
export function unsupportedBindings(bindings: Pick<Partial<Bindings>, "services">): string[] {
  const reasons: string[] = [];
  if ((bindings.services ?? []).length > 0) {
    reasons.push("service bindings call another deployment through an edge, which a standalone binary has none of");
  }
  return reasons;
}

function assertStandaloneSupported(input: BuildInput): void {
  const blocked = unsupportedBindings(input.config);
  if (blocked.length > 0) {
    throw new Error(`cannot build a standalone binary for this project:\n  - ${blocked.join("\n  - ")}`);
  }
}

/**
 * Whether the worker of a Cloud deploy can read its own assets, so the module would have to carry them. Cloudflare gives the worker
 * `env.<BINDING>` only when `assets.binding` is set, and runs it before the files only for `run_worker_first` (here
 * `run_sprout_first`): `true` or a non-empty route list. A worker with either calls `env.ASSETS.fetch(request)`, which reads the
 * module's embedded files; the Cloud's edge serves a request the worker never sees. An app with neither has its files served
 * by the edge alone, and the module carries none. Whether the files FIT is `planAssetBake`'s question.
 */
export function workerReadsAssets(assets: BuildInput["config"]["assets"]): boolean {
  if (!assets) return false;
  const first = assets.run_sprout_first;
  return Boolean(assets.binding) || first === true || (Array.isArray(first) && first.length > 0);
}

/**
 * The module ABI region for static data: the patched Porffor linker throws `static data exceeds module ABI region` when the data
 * of ONE module reaches this many bytes (toolchain a21 patch, `off >= 1048576`). It counts every string literal of the module
 * (runtime prelude, the worker's own strings, the baked files and their manifest), not code.
 */
export const MODULE_STATIC_LIMIT = 1_048_576;
/** Kept free below the limit so a prelude that grows, or an estimate that is a little low, never turns into a failed deploy. */
export const MODULE_STATIC_MARGIN = 65_536;
/**
 * Static data of a module with no assets and no strings of its own: measured at 126,080 bytes with runtime 0.47 (a render of the
 * kitchen-sink shape, bisecting the file size until the linker threw), rounded up.
 */
export const MODULE_STATIC_BASE = 131_072;
/**
 * Static data one baked file costs besides its bytes. Measured at 102 to 125 bytes per file (1,000 and 3,000 files, keys of about
 * 40 characters): the key (kept once, the manifest and the file map share it), the 64-character hash and the entry's other
 * strings. Used as key length + this, which stays above the measured cost.
 */
const STATIC_PER_FILE = 88;

export type AssetBakePlan = {
  /** The worker would read its assets (see workerReadsAssets). */
  reads: boolean;
  /** The files go into the module: the worker reads them and they fit. */
  bake: boolean;
  files: number;
  /** Raw size of the files. */
  fileBytes: number;
  /** Static data the baked files and their manifest would take. */
  bakedBytes: number;
  /** What the module can spend on them: the limit minus the margin, the base and the worker's own strings. */
  budget: number;
  /** `bakedBytes` past `budget`; 0 when it fits. */
  overBy: number;
};

/**
 * Decide whether a Cloud emit bakes the assets into the module: only when the worker reads them AND they fit. Bytes are measured
 * on what the build puts into static data, not the directory size: a baked file is a latin1 string (one byte per byte, binary or
 * text alike, confirmed against the linker), plus per file its key and manifest entry, plus the worker's own strings. The worker's
 * source counts in full (its code takes no static data, so this is an upper bound: a margin, not a measurement).
 *
 * The files that do not fit stay out, as in 0.58.0: the edge still serves them from the Cloud asset store, but `env.ASSETS.fetch`
 * in the worker finds none until the runtime reads that store.
 */
export function planAssetBake(input: BuildInput): AssetBakePlan {
  const assets = input.config.assets;
  const reads = workerReadsAssets(assets);
  const empty = { reads, bake: reads, files: 0, fileBytes: 0, bakedBytes: 0, budget: 0, overBy: 0 };
  if (!assets || !reads) return { ...empty, bake: false };
  const dir = resolve(input.projectDir, assets.directory);
  // A missing directory is the build's own error, raised with its message right after.
  if (!existsSync(dir)) return empty;
  const files = walkAssets(dir);
  let fileBytes = 0;
  let bakedBytes = 0;
  for (const [key, entry] of Object.entries(files)) {
    fileBytes += entry.size;
    bakedBytes += entry.size + Buffer.byteLength(key, "utf8") + STATIC_PER_FILE;
  }
  const rules = readAssetRules(dir);
  bakedBytes += JSON.stringify([rules.headers, rules.redirects]).length;
  // the build reads the worker from sourcePath when no source is given (build.ts), so count that file
  // bytes, not UTF-16 units: a non-ASCII string takes at least as many bytes in static data as it has characters, and UTF-8 is the upper bound
  const own =
    Buffer.byteLength(input.source ?? readFileSync(input.sourcePath, "utf8"), "utf8") +
    Buffer.byteLength(JSON.stringify(input.config.vars ?? {}), "utf8");
  const budget = Math.max(0, MODULE_STATIC_LIMIT - MODULE_STATIC_MARGIN - MODULE_STATIC_BASE - own);
  const overBy = Math.max(0, bakedBytes - budget);
  return { reads, bake: overBy === 0, files: Object.keys(files).length, fileBytes, bakedBytes, budget, overBy };
}

/** The deploy's "assets" detail: which way the files go and why. */
export function describeAssetBake(plan: AssetBakePlan): string {
  const bytes = (n: number) => n.toLocaleString("en-US");
  if (!plan.reads) return "served by the edge, none in the module (the worker does not read env.ASSETS)";
  if (plan.bake)
    return `served by the edge, and kept in the module (the worker reads env.ASSETS; fits: ${bytes(plan.bakedBytes)} of ${bytes(plan.budget)} bytes)`;
  return `served by the edge, none in the module (the worker reads env.ASSETS but the files are too big to bake: ${bytes(plan.overBy)} bytes over the limit of ${bytes(plan.budget)})`;
}

/** The warning for a worker that reads its assets whose files do not fit, or undefined. */
export function assetBakeWarning(plan: AssetBakePlan): string | undefined {
  if (!plan.reads || plan.bake) return undefined;
  return (
    `the assets (${plan.files} files, ${plan.fileBytes.toLocaleString("en-US")} bytes) do not fit in the module: ` +
    `${plan.overBy.toLocaleString("en-US")} bytes over the limit. env.ASSETS.fetch inside the worker will not find these files on the Cloud ` +
    `until the runtime reads the asset store; requests the edge serves from it still work`
  );
}

/**
 * `sproutboat build --standalone --emit-only`: the standalone build up to and
 * including `sprout.generated.js`, byte for byte what a full standalone build
 * compiles, at the same path. Every check that fails a standalone build fails
 * this too; nothing native is acquired or compiled and no binary is copied out.
 */
export async function emitStandalone(
  input: BuildInput,
  /** The Cloud compiles this unit and its hosts supply service bindings, so a deploy to the Cloud keeps them. */
  options: { forCloud?: boolean } = {},
): Promise<{ generatedPath: string; assetBake?: AssetBakePlan }> {
  if (!options.forCloud) assertStandaloneSupported(input);
  // A Cloud deploy sends the assets as a manifest the Cloud's edge serves; baking them into the module breaks its compile past about 1 MiB
  // ("static data exceeds module ABI region"). A worker that reads its assets (a binding, or run_sprout_first) keeps them in the module
  // as well, as in 0.57.0, but only when they fit: past the limit they stay out (0.58.0), and the plan says so.
  const assetBake = options.forCloud === true ? planAssetBake(input) : undefined;
  const bakeAssets = assetBake === undefined || assetBake.bake;
  const { generatedPath } = await emitGenerated({ ...input, transport: "embedded", bakeAssets });
  return { generatedPath, assetBake };
}

export async function buildStandalone(input: StandaloneBuildInput): Promise<StandaloneBuildResult> {
  assertStandaloneSupported(input);
  const { release, ...rest } = input;
  const artifact = await buildArtifact({ ...rest, transport: "embedded", lto: release === true });

  // The sprout *is* the binary: assets and bindings are compiled into it, and
  // everything else it needs (port, data dir, secrets) arrives at run time.
  const outPath = input.outPath ?? resolve(input.projectDir, "dist", input.config.name);
  await mkdir(resolve(outPath, ".."), { recursive: true });
  await cp(resolve(artifact.artifactDir, "sprout"), outPath);
  await chmod(outPath, 0o755);
  return { outPath, bytes: Bun.file(outPath).size };
}
