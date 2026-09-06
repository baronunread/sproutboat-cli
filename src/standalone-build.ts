/**
 * #15 Phase 0 — `sproutboat build --standalone`.
 *
 * Emits ONE executable that carries the compiled sprout, the static assets and
 * the binding declarations. `bun build --compile` supplies the packaging: the
 * generated entry imports the sprout and the asset bundle as embedded files, so
 * the result needs no Bun on the target and nothing beside it on disk.
 *
 * It is large — a Bun runtime is tens of megabytes against a ~0.4 MB sprout —
 * and that is the point of calling it Phase 0. It proves the shape and gives
 * the conformance suite a second backend to run against; Phase 1 replaces the
 * bundled broker with an embedded dispatch and the size problem goes away.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssetManifest } from "./assets";
import { buildArtifact, type BuildInput } from "./build";
import type { StandaloneManifest } from "./standalone-runtime";

export type StandaloneBuildInput = BuildInput & {
  /** Where to write the executable. Defaults to `<projectDir>/dist/<name>`. */
  outPath?: string;
  /** Temp scratch for the generated entry + embedded payloads. */
  workDir: string;
  /** Defaults to the phase-0 bundled broker. */
  backend?: StandaloneBackend;
};

export type StandaloneBuildResult = { outPath: string; bytes: number };

/**
 * Which backend serves the bindings inside the executable.
 *
 * `bundled` (phase 0) ships the real broker, so every binding the platform has
 * works exactly as deployed — including outbound `fetch`, because that broker
 * is Bun. `embedded` (phase 1) compiles the dispatch into the sprout itself and
 * loses anything that needs a network client until phase 3 lands one.
 */
export type StandaloneBackend = "bundled" | "embedded";

/**
 * Bindings a given backend cannot serve.
 *
 * A build error, not a runtime no-op: shipping a binary whose outbound
 * `fetch()` silently does nothing means discovering it in production, on a
 * device someone has to physically reach.
 */
export function unsupportedBindings(
  bindings: Partial<StandaloneManifest["bindings"]>,
  backend: StandaloneBackend,
): string[] {
  const reasons: string[] = [];
  // No edge, no other deployments to call — true of any standalone binary.
  if ((bindings.services ?? []).length > 0) {
    reasons.push("service bindings call another deployment through an edge, which a standalone binary has none of");
  }
  if (backend === "embedded" && (bindings.outbound ?? []).length > 0) {
    reasons.push("outbound fetch() needs an HTTP client and TLS compiled in (phase 3)");
  }
  return reasons;
}

/**
 * Read the assets the artifact build already produced, rather than re-walking
 * the source directory: `buildArtifact` copies them to `<artifact>/assets` and
 * writes `assets.json` beside it, so embedding those exact bytes is what keeps
 * a standalone binary serving what a deployed artifact would.
 */
async function embedAssets(artifactDir: string): Promise<StandaloneManifest["assets"]> {
  let manifest: AssetManifest;
  try {
    // SAFETY: assets.json is written by buildArtifact moments earlier, from the
    // AssetManifest contract — this is our own output, not user input.
    manifest = JSON.parse(await readFile(resolve(artifactDir, "assets.json"), "utf8")) as AssetManifest;
  } catch {
    return undefined; // no assets configured
  }
  const files: Record<string, string> = {};
  for (const path of Object.keys(manifest.files)) {
    files[path] = Buffer.from(await readFile(resolve(artifactDir, "assets", `.${path}`))).toString("base64");
  }
  return { manifest, files };
}

export async function buildStandalone(input: StandaloneBuildInput): Promise<StandaloneBuildResult> {
  const artifact = await buildArtifact(input);
  const bindingsPath = resolve(artifact.artifactDir, "bindings.json");
  let bindings: StandaloneManifest["bindings"] = {};
  try {
    // SAFETY: bindings.json is written by buildArtifact from the validated
    // config in this same call — our own output, not user input.
    bindings = JSON.parse(await readFile(bindingsPath, "utf8")) as StandaloneManifest["bindings"];
  } catch {
    bindings = {}; // a project with no bindings at all
  }

  const blocked = unsupportedBindings(bindings, input.backend ?? "bundled");
  if (blocked.length > 0) {
    throw new Error(`cannot build a standalone binary for this project:\n  - ${blocked.join("\n  - ")}`);
  }

  const manifest: StandaloneManifest = {
    name: input.config.name,
    bindings,
    assets: await embedAssets(artifact.artifactDir),
  };

  await mkdir(input.workDir, { recursive: true });
  const sproutCopy = resolve(input.workDir, "sprout.bin");
  await writeFile(sproutCopy, await readFile(resolve(artifact.artifactDir, "sprout")));
  const manifestPath = resolve(input.workDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));

  // The entry is generated rather than checked in because the embedded imports
  // must be static for `bun build --compile` to find and inline them.
  const entryPath = resolve(input.workDir, "entry.ts");
  await writeFile(
    entryPath,
    [
      `import sproutFile from "./sprout.bin" with { type: "file" };`,
      `import manifestFile from "./manifest.json" with { type: "file" };`,
      `import { runStandalone, type StandaloneManifest } from ${JSON.stringify(resolve(import.meta.dir, "standalone-runtime.ts"))};`,
      ``,
      `const manifest: StandaloneManifest = await Bun.file(manifestFile).json();`,
      `const sprout = new Uint8Array(await Bun.file(sproutFile).arrayBuffer());`,
      `const { code } = await runStandalone(manifest, sprout, Bun.argv.slice(2));`,
      `process.exit(code);`,
      ``,
    ].join("\n"),
  );

  const outPath = input.outPath ?? resolve(input.projectDir, "dist", input.config.name);
  await mkdir(resolve(outPath, ".."), { recursive: true });
  const compile = Bun.spawn(["bun", "build", "--compile", entryPath, "--outfile", outPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  if (status !== 0) throw new Error(`bun build --compile failed:\n${stderr}`);

  return { outPath, bytes: Bun.file(outPath).size };
}
