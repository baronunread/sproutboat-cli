import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { walkAssets, type AssetManifest } from "./assets";
import { resourceRefs, type SproutboatConfig } from "./config";
import { compileSprout } from "./compile";
import {
  ARTIFACT_SCHEMA_VERSION,
  CAPABILITY_PROFILE,
  DEPLOY_TARGET,
  hostTarget,
  RUNTIME,
  type ArtifactManifest,
} from "./manifest";
import { ensureZig, esbuildVersion, porfforVersion, toolchainStamp } from "./toolchain";

export type BuildInput = {
  projectDir: string;
  config: SproutboatConfig;
  sourcePath: string;
  /**
   * The bundled module (#89). When present this is what gets hashed and
   * compiled, so the artifact tracks every imported file rather than just the
   * entry point — change a dependency, get a different version.
   */
  source?: string;
  /**
   * `host` (#62) compiles for this machine instead of cross-compiling for a
   * box, so `sproutboat dev` can run the sprout locally. The manifest records
   * the real target, which is what stops the result being deployed.
   */
  target?: "linux-x86_64" | "host";
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
  const source = input.source ?? (await readFile(input.sourcePath));
  const sourceHash = digest(source);
  const artifactId = sourceHash.slice("sha256:".length, 24);
  const artifactDir = resolve(input.projectDir, ".sproutboat/dist", artifactId);
  const sproutPath = resolve(artifactDir, "sprout");
  await mkdir(artifactDir, { recursive: true });

  // #74 — split each storage-binding array into its binding-name list (the
  // legacy shape the prelude/broker read) plus a `resources` map { binding ->
  // { kind, id } } for the entries that name an account-level resource id.
  const refsByKind = {
    kv: resourceRefs(input.config.kv_namespaces),
    d1: resourceRefs(input.config.d1_databases),
    r2: resourceRefs(input.config.r2_buckets),
    queue: resourceRefs(input.config.queues),
  };
  const resources: Record<string, { kind: string; id: string }> = {};
  for (const [kind, refs] of Object.entries(refsByKind)) {
    for (const ref of refs) if (ref.id) resources[ref.binding] = { kind, id: ref.id };
  }
  const bindings = {
    kv: refsByKind.kv.map((ref) => ref.binding),
    secrets: input.config.secrets ?? [],
    outbound: input.config.outbound ?? [],
    d1: refsByKind.d1.map((ref) => ref.binding),
    r2: refsByKind.r2.map((ref) => ref.binding),
    queues: refsByKind.queue.map((ref) => ref.binding),
    analytics: input.config.analytics_engine_datasets ?? [],
    do: Object.entries(input.config.durable_objects ?? {}).map(([binding, className]) => ({ binding, className })),
    crons: input.config.triggers?.crons ?? [],
    assets: input.config.assets?.binding ?? "",
    // Baked plain values, read as env.NAME. The broker never serves these (they
    // are compiled in via SPROUTBOAT_VARS_JSON); they ride along so the control
    // plane can show what a version was built with. Not secret — `secrets` is
    // that, and it carries names only.
    vars: input.config.vars ?? {},
    resources,
  };

  // A host build never shells out to `zig`, so do not fetch a 50 MB toolchain
  // for it — that download is the slowest part of a first local build.
  const host = input.target === "host";
  const zigBin = host ? undefined : await ensureZig();
  await compileSprout({
    sourcePath: input.sourcePath,
    source: input.source,
    outPath: sproutPath,
    vars: input.config.vars ?? {},
    bindings,
    zigBin,
    target: input.target,
  });

  const sprout = await readFile(sproutPath);
  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    project: input.config.name,
    target: host ? hostTarget() : DEPLOY_TARGET,
    runtime: RUNTIME,
    capabilityProfile: CAPABILITY_PROFILE,
    porfforVersion: porfforVersion(),
    esbuildVersion: esbuildVersion(),
    buildImage: toolchainStamp(),
    sourceHash,
    binaryHash: digest(sprout),
    binarySize: (await stat(sproutPath)).size,
    builtAt: new Date().toISOString(),
  };
  await writeFile(resolve(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // Bindings live beside the manifest, not in it: the artifact manifest schema is
  // frozen at v2. The control plane reads this to configure the per-deployment
  // broker (KV / D1 / R2 / queue names, secret names, outbound allowlist, cron
  // schedules, Durable Object classes).
  const hasBindings =
    Object.values(bindings).some((value) => Array.isArray(value) && value.length > 0) ||
    Object.keys(bindings.resources).length > 0 ||
    Object.keys(bindings.vars).length > 0;
  if (hasBindings) {
    await writeFile(resolve(artifactDir, "bindings.json"), `${JSON.stringify(bindings, null, 2)}\n`);
  }

  // Static assets: copy the directory next to the artifact and record a manifest
  // the edge serves from directly (assets-first) and the broker reads for
  // `env.<ASSETS>.fetch()`.
  if (input.config.assets) {
    const srcDir = resolve(input.projectDir, input.config.assets.directory);
    const outDir = resolve(artifactDir, "assets");
    if (
      !(await stat(srcDir)
        .then((s) => s.isDirectory())
        .catch(() => false))
    ) {
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
