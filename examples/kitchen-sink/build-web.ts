/**
 * Build the dashboard's static assets: copy public/ to dist/ and write what only
 * the build knows. `sproutboat build` itself only copies `assets.directory`, so
 * this runs first, Wrangler-style (`bun run build`; the harnesses call it too).
 *
 * dist/build-info.json is the one place the page gets build-time facts from:
 *
 *   module     bytes of src/index.js, the worker source this build ships
 *   assets     every file in dist/ with its size (build-info.json itself and the
 *              harness fixture left out), so the size card sums real files
 *   snippets   the code between `// #region <name>` markers in src/index.js,
 *              copied verbatim into the tiles' Code panels
 *   config     compatibility date, crons, secret names and the bindings declared
 *              in sproutboat.jsonc
 *
 * Nothing is estimated. The compiled binary's size is not here on purpose: it
 * depends on the target and on LTO, and `sproutboat build --standalone` prints it.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseConfig } from "../../src/config";

const HERE = import.meta.dir;
const PUBLIC = join(HERE, "public");
const DIST = join(HERE, "dist");

/** The code between `// #region name` and `// #endregion`, by name. */
export function extractRegions(source: string): Map<string, string> {
  const regions = new Map<string, string>();
  const pattern = /^\/\/ #region (\w+)\n([\s\S]*?)^\/\/ #endregion$/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;
    regions.set(name, body.trimEnd());
  }
  return regions;
}

function walk(dir: string): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push({ path: relative(DIST, full).split("\\").join("/"), bytes: statSync(full).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function buildWebUi(): string {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  cpSync(PUBLIC, DIST, { recursive: true });

  const configText = readFileSync(join(HERE, "sproutboat.jsonc"), "utf8");
  const parsed = parseConfig(configText);
  if (!parsed.ok) throw new Error("bad sproutboat.jsonc: " + parsed.errors.join("; "));
  const config = parsed.value;

  const sourceText = readFileSync(join(HERE, config.main), "utf8");
  const regions = extractRegions(sourceText);
  for (const name of ["kv", "d1", "r2", "chat", "queue", "service", "secrets"]) {
    if (!regions.get(name)) throw new Error(`src/index.js has no \`// #region ${name}\` block`);
  }

  const bindings: Array<{ binding: string; type: string }> = [
    ...(config.kv_namespaces ?? []).map((binding) => ({ binding, type: "KV" })),
    ...(config.d1_databases ?? []).map((binding) => ({ binding, type: "D1" })),
    ...(config.r2_buckets ?? []).map((binding) => ({ binding, type: "R2" })),
    ...(config.queues ?? []).map((binding) => ({ binding, type: "Queue" })),
    ...(config.analytics_engine_datasets ?? []).map((binding) => ({ binding, type: "Analytics Engine" })),
    ...Object.keys(config.durable_objects ?? {}).map((binding) => ({ binding, type: "Durable Object" })),
    ...(config.ratelimiters ?? []).map((entry) => ({ binding: entry.binding, type: "Rate limiter" })),
    ...(config.services ?? []).map((entry) => ({ binding: entry.binding, type: "Service" })),
    ...(config.secrets ?? []).map((binding) => ({ binding, type: "Secret" })),
    ...(config.assets ? [{ binding: config.assets.binding ?? "ASSETS", type: "Assets" }] : []),
  ];

  // Every byte value catches UTF-8 decoding, replacement and truncation bugs. The
  // conformance suite reads it back; it is not part of the measured assets.
  const binary = new Uint8Array(256);
  for (let index = 0; index < binary.length; index++) binary[index] = index;
  writeFileSync(join(DIST, "binary-fixture.bin"), binary);

  const info = {
    builtAt: new Date().toISOString(),
    compatibilityDate: config.compatibility_date,
    crons: config.triggers?.crons ?? [],
    secrets: config.secrets ?? [],
    bindings,
    module: { path: config.main, bytes: Buffer.byteLength(sourceText) },
    assets: walk(DIST).filter((file) => file.path !== "binary-fixture.bin"),
    snippets: Object.fromEntries(regions),
  };
  writeFileSync(join(DIST, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  if (!existsSync(join(DIST, "index.html"))) throw new Error("public/index.html is missing");
  console.log(`built the dashboard: ${info.assets.length} assets, ${info.module.bytes} byte module`);
  return DIST;
}

if (import.meta.main) buildWebUi();
