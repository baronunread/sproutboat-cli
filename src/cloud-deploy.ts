/**
 * `sproutboat deploy` against the Sproutboat Cloud: upload the compiled module by digest, the assets by hash,
 * write the app, and wait for a host to apply it. The same calls tools/sbcloud-deploy makes in the cloud repo.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAssetRules, walkAssets, type AssetManifest } from "./assets";
import type { SproutboatConfig } from "./config";
import { authHeaders, CloudError, explainApiFailure, parseBody, type CloudIo } from "./cloud";
import { isSafeInteger, isString, jsonObject, type JsonObject } from "./json";

export const CLOUD_PROJECT_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

export const hostFor = (project: string, team: string): string => `${project}.${team}.sproutboat.app`;

export type AssetBundle = {
  /** The manifest JSON as it is uploaded; its sha256 names it. */
  manifestText: string;
  manifestSha: string;
  /** Blob digest to the file that holds it. */
  blobs: Map<string, string>;
  files: number;
  bytes: number;
};

/** The same manifest `sproutboat build` writes as assets.json, read straight from the project's assets directory. */
export function buildAssetBundle(projectDir: string, assets: NonNullable<SproutboatConfig["assets"]>): AssetBundle {
  const dir = resolve(projectDir, assets.directory);
  if (!existsSync(dir))
    throw new CloudError(`assets.directory "${assets.directory}" not found; run your site build first`);
  const manifest: AssetManifest = {
    notFound: assets.not_found_handling ?? "none",
    runSproutFirst: assets.run_sprout_first ?? false,
    files: walkAssets(dir),
  };
  const rules = readAssetRules(dir);
  if (rules.headers.length) manifest.headers = rules.headers;
  if (rules.redirects.length) manifest.redirects = rules.redirects;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const blobs = new Map<string, string>();
  let bytes = 0;
  for (const [key, entry] of Object.entries(manifest.files)) {
    blobs.set(entry.hash, resolve(dir, `.${key}`));
    bytes += entry.size;
  }
  return {
    manifestText,
    manifestSha: createHash("sha256").update(manifestText).digest("hex"),
    blobs,
    files: Object.keys(manifest.files).length,
    bytes,
  };
}

export type CloudDeployPlan = {
  apiUrl: string;
  token: string;
  tokenFromEnv: boolean;
  project: string;
  hosts: string[];
  modulePath: string;
  assets?: AssetBundle;
  noWait: boolean;
  /** Milliseconds to wait for a host to apply the record. */
  waitMs?: number;
  pollMs?: number;
};

export type CloudDeployResult = {
  created: boolean;
  generation: number;
  url: string | undefined;
  applied: boolean | "skipped";
};

type AppSpec = { module: { sha256: string }; hosts: string[]; assets_manifest_ref?: string };
type Call = { method: string; path: string; body?: BodyInit; json?: AppSpec | { sha256: string[] }; ok?: number[] };

export async function deployToCloud(plan: CloudDeployPlan, io: CloudIo): Promise<CloudDeployResult> {
  const call = async (c: Call): Promise<{ status: number; text: string; body?: JsonObject }> => {
    const headers = new Headers(authHeaders(plan.token));
    let body = c.body;
    if (c.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(c.json);
    } else if (body !== undefined) headers.set("content-type", "application/octet-stream");
    let response: Response;
    try {
      response = await fetch(`${plan.apiUrl}${c.path}`, { method: c.method, headers, body });
    } catch {
      throw new CloudError(`cannot reach ${plan.apiUrl}; check the address and your network`);
    }
    const text = await response.text();
    if (!response.ok && !(c.ok ?? []).includes(response.status))
      throw new CloudError(explainApiFailure(response.status, text, plan.tokenFromEnv));
    return { status: response.status, text, body: parseBody(text) };
  };

  // What the app holds now: tells a first deploy from an update, and keeps its assets when this deploy has none.
  const current = await call({ method: "GET", path: `/v1/apps/${plan.project}`, ok: [404] });
  const created = current.status === 404;
  let assetsRef: string | null | undefined;
  if (plan.assets) {
    await pushAssets(call, plan.assets, io);
    assetsRef = `assets/${plan.assets.manifestSha}`;
  } else if (!created) {
    const spec = jsonObject(current.body?.spec ?? null);
    const ref = spec?.assets_manifest_ref;
    if (isString(ref)) {
      assetsRef = ref;
      io.log(`  assets  keeping the current ${ref.slice(0, 19)}`);
    }
  }

  const bytes = new Uint8Array(readFileSync(plan.modulePath));
  const sha = createHash("sha256").update(bytes).digest("hex");
  io.log(`  module  ${sha.slice(0, 12)} (${(bytes.byteLength / 1024).toFixed(0)} KiB)`);
  await call({ method: "PUT", path: `/v1/modules/${sha}`, body: bytes });

  const spec: AppSpec = { module: { sha256: sha }, hosts: plan.hosts };
  if (assetsRef !== undefined && assetsRef !== null) spec.assets_manifest_ref = assetsRef;
  const put = await call({ method: "PUT", path: `/v1/apps/${plan.project}`, json: spec });
  const generation = put.body?.record_generation;
  if (!isSafeInteger(generation)) throw new CloudError("the Cloud's reply carried no record generation");
  const url = plan.hosts[0] === undefined ? undefined : `https://${plan.hosts[0]}`;
  if (plan.noWait) return { created, generation, url, applied: "skipped" };

  const deadline = Date.now() + (plan.waitMs ?? 120_000);
  io.log(`  record generation ${generation} written; waiting for a host to apply it`);
  for (;;) {
    const state = await call({ method: "GET", path: `/v1/apps/${plan.project}` });
    const apply = jsonObject(state.body?.apply ?? null);
    const phase = apply?.state;
    if (phase === "failed" || phase === "fenced")
      throw new CloudError(
        `the host did not apply generation ${generation} (${phase}): ${isString(apply?.error) ? apply.error : "no reason given"}`,
      );
    const applied = apply?.applied_generation;
    if (phase === "applied" && isSafeInteger(applied) && applied >= generation)
      return { created, generation, url, applied: true };
    if (Date.now() >= deadline) return { created, generation, url, applied: false };
    await io.sleep(plan.pollMs ?? 2000);
  }
}

async function pushAssets(
  call: (c: Call) => Promise<{ body?: JsonObject }>,
  bundle: AssetBundle,
  io: CloudIo,
): Promise<void> {
  const hashes = [...bundle.blobs.keys()];
  const missingBody = (await call({ method: "POST", path: "/v1/assets/missing", json: { sha256: hashes } })).body
    ?.missing;
  const missing = Array.isArray(missingBody) ? missingBody.filter(isString) : [];
  const queue = [...missing];
  let uploaded = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let hash = queue.shift(); hash !== undefined; hash = queue.shift()) {
        const file = bundle.blobs.get(hash);
        if (file === undefined) throw new CloudError("the Cloud asked for a blob the manifest does not list");
        await call({ method: "PUT", path: `/v1/assets/blobs/${hash}`, body: new Uint8Array(readFileSync(file)) });
        uploaded++;
      }
    }),
  );
  await call({
    method: "PUT",
    path: `/v1/assets/manifests/${bundle.manifestSha}`,
    body: new TextEncoder().encode(bundle.manifestText),
  });
  io.log(`  assets  ${bundle.files} files, ${uploaded} of ${hashes.length} blobs uploaded`);
}

export type ModuleInputs = {
  project: string;
  /** Emits sprout.generated.js for the project and returns its path. */
  emit: () => Promise<string>;
  sproutd?: string;
  generation?: string;
  out: string;
  /** The bun to run compile-app with. */
  bun: string;
};

/**
 * Compile the app into a module the way tools/sbcloud-deploy does: the CLI's standalone emit, then sproutd's
 * compile-app against a built generation. There is no hosted compile service yet, so both directories are the
 * caller's to supply.
 */
export async function compileModule(input: ModuleInputs): Promise<void> {
  const { sproutd, generation } = input;
  if (!sproutd || !generation)
    throw new CloudError(
      [
        "a Cloud deploy needs a compiled module, and there is no hosted compile service yet.",
        "  Pass a prebuilt one:        sproutboat deploy --module app.so",
        "  or compile here with:       sproutboat deploy --sproutd <sproutd checkout> --generation <built generation>",
        "  (or SPROUTBOAT_SPROUTD and SPROUTBOAT_GENERATION in the environment)",
      ].join("\n"),
    );
  const compiler = resolve(sproutd, "build/compile-app.ts");
  if (!existsSync(compiler)) throw new CloudError(`${compiler} not found (--sproutd)`);
  if (!existsSync(resolve(generation, "manifest.json")))
    throw new CloudError(`${resolve(generation)} is not a built generation (--generation)`);
  const unit = await input.emit();
  const run = Bun.spawnSync([input.bun, compiler, resolve(generation), unit, input.out, "--name", input.project], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = run.stdout.toString();
  if (run.exitCode !== 0)
    throw new CloudError(
      `the compile was not admitted (exit ${run.exitCode}):\n${(stdout + run.stderr.toString()).trim().slice(-2000)}`,
    );
  if (!existsSync(input.out) || Bun.file(input.out).size === 0)
    throw new CloudError(`the compiler reported success but wrote no module to ${input.out}`);
}
