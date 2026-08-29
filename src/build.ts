import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

  const zigBin = await ensureZig();
  await compileWorker({
    sourcePath: input.sourcePath,
    outPath: workerPath,
    vars: input.config.vars ?? {},
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
  return { artifactDir, manifest };
}
