import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { walkAssets, type AssetManifest } from "./assets";
import type { SproutboatConfig } from "./config";
import { compileWorker } from "./compile";
import { ARTIFACT_SCHEMA_VERSION, CAPABILITY_PROFILE, RUNTIME, type ArtifactManifest } from "./manifest";
import { ensureZig, esbuildVersion, porfforVersion, toolchainStamp } from "./toolchain";

export type BuildInput = {
  projectDir: string;
  config: SproutboatConfig;
  sourcePath: string;
};

export type BuildOutput = {
  artifactDir: string;
  manifest: ArtifactManifest;
};

function digest(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Cross-compile a handler into a linux-x86_64 native-fetch server binary with
 * Porffor + Zig — no Docker. The binary is not run here (the build host may not
 * be linux); the control plane starts it once on deploy and rejects it if it
 * does not come up.
 */
export async function buildArtifact(input: BuildInput): Promise<BuildOutput> {
  const source = await readFile(input.sourcePath);
  const sourceHash = digest(source);
  const artifactId = sourceHash.slice("sha256:".length, 24);
  const artifactDir = resolve(input.projectDir, ".sproutboat/dist", artifactId);
  const workerPath = resolve(artifactDir, "worker");
  await mkdir(artifactDir, { recursive: true });

  const bindings = {
    kv: input.config.kv_namespaces ?? [],
    secrets: input.config.secrets ?? [],
    outbound: input.config.outbound ?? [],
    d1: input.config.d1_databases ?? [],
    r2: input.config.r2_buckets ?? [],
    queues: input.config.queues ?? [],
    analytics: input.config.analytics_engine_datasets ?? [],
    do: Object.entries(input.config.durable_objects ?? {}).map(([binding, className]) => ({ binding, className })),
    crons: input.config.triggers?.crons ?? [],
    assets: input.config.assets?.binding ?? "",
  };

  const zigBin = await ensureZig();
  await compileWorker({
    sourcePath: input.sourcePath,
    outPath: workerPath,
    vars: input.config.vars ?? {},
    bindings,
    zigBin,
  });

  const worker = await readFile(workerPath);
  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    project: input.config.name,
    target: "linux-x86_64",
    runtime: RUNTIME,
    capabilityProfile: CAPABILITY_PROFILE,
    porfforVersion: porfforVersion(),
    esbuildVersion: esbuildVersion(),
    buildImage: toolchainStamp(),
    sourceHash,
    binaryHash: digest(worker),
    binarySize: (await stat(workerPath)).size,
    builtAt: new Date().toISOString(),
  };
  await writeFile(resolve(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Bindings live beside the manifest, not in it: the artifact manifest schema is
  // frozen at v2. The control plane reads this to configure the per-deployment
  // broker (KV / D1 / R2 / queue names, secret names, outbound allowlist, cron
  // schedules, Durable Object classes).
  if (Object.values(bindings).some((names) => names.length > 0)) {
    await writeFile(resolve(artifactDir, "bindings.json"), `${JSON.stringify(bindings, null, 2)}\n`);
  }

  // Static assets: copy the directory next to the artifact and record a manifest
  // the edge serves from directly (assets-first) and the broker reads for
  // `env.<ASSETS>.fetch()`.
  if (input.config.assets) {
    const srcDir = resolve(input.projectDir, input.config.assets.directory);
    const outDir = resolve(artifactDir, "assets");
    if (!(await stat(srcDir).then((s) => s.isDirectory()).catch(() => false))) {
      throw new Error(`assets.directory "${input.config.assets.directory}" not found — run your site build first`);
    }
    await cp(srcDir, outDir, { recursive: true });
    const assetManifest: AssetManifest = {
      notFound: input.config.assets.not_found_handling ?? "none",
      runSproutFirst: input.config.assets.run_sprout_first ?? false,
      files: walkAssets(outDir),
    };
    await writeFile(resolve(artifactDir, "assets.json"), `${JSON.stringify(assetManifest, null, 2)}\n`);
  }
  return { artifactDir, manifest };
}
