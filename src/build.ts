import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { walkAssets, type AssetManifest } from "./assets";
import { resourceRefs, type SproutboatConfig } from "./config";
import { ensureSqliteObject } from "./sqlite";
import { sqliteStamp } from "./sqlite";
import { bearsslStamp, ensureBearssl } from "./bearssl";
import { compileSprout, loadPrelude, type Transport } from "./compile";
import { compileCached } from "./compile-cache";
import {
  ARTIFACT_SCHEMA_VERSION,
  CAPABILITY_PROFILE,
  DEPLOY_TARGET,
  hostTarget,
  RUNTIME,
  type ArtifactManifest,
} from "./manifest";
import { ensureZig, esbuildVersion, porfforVersion, toolchainStamp } from "./toolchain";
import { PORFFOR_ARCHIVE_SHA256, PORFFOR_COMMIT_FULL } from "./porffor-toolchain";
import { version as toolchainPackageVersion } from "@sproutboat/toolchain/package.json" with { type: "json" };
import { version as cliVersion } from "../package.json" with { type: "json" };
import { wrapNativeFetchHandler } from "./wrap";

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
  /** #15 — `embedded` compiles SQLite into the sprout instead of a broker
   *  transport. Defaults to the broker transport. */
  transport?: Transport;
  /**
   * `dev` compiles at -O0, which is roughly three times faster and produces a
   * bigger binary. Only for artifacts that cannot be deployed: `deploy` refuses
   * a host build already, and this defaults to `release` so a caller has to ask
   * for the fast path deliberately.
   */
  optimize?: "dev" | "release";
  /** Reuse a previously compiled native sprout when only sidecar assets changed. */
  reuseSproutPath?: string;
  /** An isolated artifact directory, used by dev candidates to avoid mixing snapshots. */
  outputDirectory?: string;
  /** Stable compiler input used only by the local dev loop. */
  generatedPath?: string;
};

export type BuildOutput = {
  artifactDir: string;
  manifest: ArtifactManifest;
  compileCache: "hit" | "miss" | "bypass";
  compileMs: number;
};

/** Baking megabytes of assets into the module makes the Porffor compile crawl;
 *  past this it is the wrong tool and the error says what to do instead. */
const MAX_BAKED_ASSET_BYTES = 8_000_000;

function digest(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function integrationIdentity(): Promise<string> {
  // A published CLI has immutable bundled integration code and a release
  // version. Source checkouts also hash their live files, so local edits never
  // accidentally reuse a binary compiled by an earlier checkout state.
  if (import.meta.url.includes("/$bunfs/")) {
    const executable = await stat(process.execPath);
    return `release:${cliVersion}:${executable.size}:${executable.mtimeMs}`;
  }
  const files = ["build.ts", "compile.ts", "sqlite.ts", "bearssl.ts", "toolchain.ts"].map((file) =>
    resolve(import.meta.dir, file),
  );
  files.push(Bun.resolveSync("@sproutboat/toolchain/patch", import.meta.dir));
  return digest(Buffer.concat(await Promise.all(files.map((file) => readFile(file)))));
}

async function acquireArtifactLock(artifactDir: string): Promise<string> {
  const lock = `${artifactDir}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + 12 * 60_000;
  while (true) {
    try {
      await mkdir(lock);
      return lock;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for artifact lock ${lock}`);
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 15 * 60_000) await rm(lock, { recursive: true, force: true });
      else await Bun.sleep(100);
    }
  }
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
  const target = input.target ?? "linux-x86_64";
  const embedded = input.transport === "embedded";

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
    services: input.config.services ?? [],
    crons: input.config.triggers?.crons ?? [],
    ratelimiters: input.config.ratelimiters ?? [],
    assets: input.config.assets?.binding ?? "",
    // Baked plain values, read as env.NAME. The broker never serves these (they
    // are compiled in via SPROUTBOAT_VARS_JSON); they ride along so the control
    // plane can show what a version was built with. Not secret — `secrets` is
    // that, and it carries names only.
    vars: input.config.vars ?? {},
    resources,
  };

  const host = target === "host";
  const assetDir = input.config.assets ? resolve(input.projectDir, input.config.assets.directory) : undefined;
  if (
    assetDir &&
    !(await stat(assetDir)
      .then((s) => s.isDirectory())
      .catch(() => false))
  ) {
    throw new Error(`assets.directory "${input.config.assets?.directory}" not found — run your site build first`);
  }
  const assetManifest: AssetManifest | undefined =
    assetDir && input.config.assets
      ? {
          notFound: input.config.assets.not_found_handling ?? "none",
          runSproutFirst: input.config.assets.run_sprout_first ?? false,
          files: walkAssets(assetDir),
        }
      : undefined;
  // #15 — an embedded binary has no files beside it, so assets are baked into
  // the module. Read them from the source directory: the artifact copy happens
  // after the compile, and the compile is what needs them. Bytes travel as a
  // latin1 string, one char per byte, which is what the asset shim hands back.
  let bakedAssets: { manifest: AssetManifest; files: Record<string, string> } | undefined;
  if (embedded && assetDir && assetManifest) {
    const files: Record<string, string> = {};
    let total = 0;
    for (const key of Object.keys(assetManifest.files)) {
      const bytes = await readFile(resolve(assetDir, `.${key}`));
      total += bytes.byteLength;
      if (total > MAX_BAKED_ASSET_BYTES) {
        throw new Error(
          `assets are too large to compile into a standalone binary (over ${MAX_BAKED_ASSET_BYTES / 1_000_000} MB). ` +
            "Serve them from R2, or drop the assets binding and put a web server in front.",
        );
      }
      files[key] = bytes.toString("latin1");
    }
    bakedAssets = { manifest: assetManifest, files };
  }

  // Version metadata is compiled into the executable. Its timestamp makes a
  // new binary necessary on every build when this binding is configured.
  const builtAt = new Date().toISOString();
  const versionId = digest(
    JSON.stringify({ sourceHash, target, config: input.config, assets: assetManifest, toolchain: toolchainStamp() }),
  ).slice("sha256:".length, 24);
  const versionMetadata = input.config.version_metadata
    ? { binding: input.config.version_metadata, id: versionId, tag: input.config.name, timestamp: builtAt }
    : undefined;
  const generatedSource = wrapNativeFetchHandler(
    source.toString(),
    await loadPrelude(input.transport ?? "broker"),
    input.config.vars ?? {},
    bindings,
    undefined,
    input.config.compatibility_date,
    input.config.name,
    bakedAssets,
    input.transport,
    versionMetadata,
  );
  const compileKey = digest(
    JSON.stringify({
      generatedSource,
      target,
      optimize: input.optimize ?? "release",
      toolchain: toolchainStamp(),
      toolchainPackageVersion,
      porffor: [PORFFOR_COMMIT_FULL, PORFFOR_ARCHIVE_SHA256],
      native: embedded ? [sqliteStamp(), bearsslStamp()] : [],
      integration: await integrationIdentity(),
    }),
  ).slice("sha256:".length);
  const artifactId = versionMetadata
    ? versionId
    : digest(JSON.stringify({ compileKey, config: input.config, assets: assetManifest })).slice("sha256:".length, 24);
  const artifactDir = input.outputDirectory ?? resolve(input.projectDir, ".sproutboat/dist", artifactId);
  const sproutPath = resolve(artifactDir, "sprout");
  const artifactLock = await acquireArtifactLock(artifactDir);
  try {
    await mkdir(artifactDir, { recursive: true });

    const compile = async (outPath: string) => {
      // Acquire native inputs only after a cache miss. A host build never needs
      // the cross-compiler; embedded builds link SQLite and BearSSL as well.
      const zigBin = host ? undefined : await ensureZig();
      const [sqliteObject, tls] = embedded
        ? await Promise.all([ensureSqliteObject({ target, zigBin }), ensureBearssl({ target, zigBin })])
        : [null, null];
      await compileSprout({
        sourcePath: input.sourcePath,
        generatedPath: input.generatedPath,
        generatedSource,
        outPath,
        vars: input.config.vars ?? {},
        bindings,
        zigBin,
        target: input.target,
        compatibilityDate: input.config.compatibility_date,
        transport: input.transport,
        appName: input.config.name,
        assets: bakedAssets,
        extraLink: [...(sqliteObject ? [sqliteObject] : []), ...(tls ? tls.objects : [])],
        extraCflags: tls ? ["-I", tls.includeDir] : [],
        optimize: input.optimize,
        versionMetadata,
      });
    };
    let compileCache: BuildOutput["compileCache"] = "bypass";
    const compileStartedAt = performance.now();
    if (
      !input.reuseSproutPath &&
      !host &&
      input.optimize !== "dev" &&
      !input.outputDirectory &&
      !versionMetadata &&
      !process.env.SPROUTBOAT_PORFFOR_DIR &&
      !process.env.SPROUTBOAT_ZIG &&
      !process.env.SPROUTBOAT_UWS_TARBALL &&
      !process.env.SPROUTBOAT_BUILD_UWS_FROM_SOURCE &&
      !process.env.PORFFOR_VERSION
    ) {
      compileCache = await compileCached(
        resolve(input.projectDir, ".sproutboat/compile-cache"),
        compileKey,
        sproutPath,
        compile,
      );
    } else {
      const candidate = resolve(artifactDir, `.sprout-${randomUUID()}`);
      try {
        if (input.reuseSproutPath) await cp(input.reuseSproutPath, candidate);
        else await compile(candidate);
        await rename(candidate, sproutPath);
      } finally {
        await rm(candidate, { force: true });
      }
    }
    const compileMs = Math.round(performance.now() - compileStartedAt);

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
      compatibilityDate: input.config.compatibility_date,
      sourceHash,
      binaryHash: digest(sprout),
      binarySize: (await stat(sproutPath)).size,
      builtAt,
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
    } else await rm(resolve(artifactDir, "bindings.json"), { force: true });

    // Static assets: copy the directory next to the artifact and record a manifest
    // the edge serves from directly (assets-first) and the broker reads for
    // `env.<ASSETS>.fetch()`.
    if (assetDir && assetManifest) {
      const outDir = resolve(artifactDir, "assets");
      await rm(outDir, { recursive: true, force: true });
      await cp(assetDir, outDir, { recursive: true });
      if (JSON.stringify(walkAssets(outDir)) !== JSON.stringify(assetManifest.files)) {
        throw new Error("assets changed during the build; retry after the asset build finishes");
      }
      await writeFile(resolve(artifactDir, "assets.json"), `${JSON.stringify(assetManifest, null, 2)}\n`);
    } else {
      await rm(resolve(artifactDir, "assets.json"), { force: true });
      await rm(resolve(artifactDir, "assets"), { recursive: true, force: true });
    }
    return { artifactDir, manifest, compileCache, compileMs };
  } finally {
    await rm(artifactLock, { recursive: true, force: true });
  }
}
