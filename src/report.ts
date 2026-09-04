import { readFileSync } from "node:fs";
import { gzipSync } from "bun";
import { resourceRefs, type SproutboatConfig } from "./config";
import type { ArtifactManifest } from "./manifest";
import { bold, dim, leaf, sprout } from "./style";

// Read from package.json so the banner never drifts from the published version.
// SAFETY: our own package.json, shipped beside src/ by the `files` field; npm requires `version`.
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
export const CLI_VERSION = packageJson.version;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kib = n / 1024;
  if (kib < 1024) return `${kib.toFixed(2)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
}

/** Minimal box table with a green frame. `align` marks columns to right-pad-left (numbers). */
function table(headers: string[], rows: string[][], align: boolean[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const rule = (l: string, m: string, r: string) => leaf(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const row = (cells: string[], head = false) =>
    leaf("│ ") +
    cells
      .map((c, i) => {
        const cell = align[i] ? (c ?? "").padStart(widths[i]) : (c ?? "").padEnd(widths[i]);
        return head ? bold(cell) : cell;
      })
      .join(leaf(" │ ")) +
    leaf(" │");
  return [
    rule("┌", "┬", "┐"),
    row(headers, true),
    rule("├", "┼", "┤"),
    ...rows.map((r) => row(r)),
    rule("└", "┴", "┘"),
  ].join("\n");
}

/** Every binding the compiled sprout will see, flattened to (name, type, detail) rows. */
function bindingRows(config: SproutboatConfig): string[][] {
  const rows: string[][] = [];
  for (const [name, value] of Object.entries(config.vars ?? {}))
    rows.push([`env.${name}`, "var", JSON.stringify(value)]);
  const list = (names: string[] | undefined, type: string, detail = "") => {
    for (const name of names ?? []) rows.push([`env.${name}`, type, detail]);
  };
  const resourceList = (refs: Parameters<typeof resourceRefs>[0], type: string) => {
    for (const ref of resourceRefs(refs)) {
      rows.push([
        `env.${ref.binding}`,
        type,
        ref.id ?? "deploy-scoped store (--no-provision) — drop the flag to auto-provision a persistent resource",
      ]);
    }
  };
  resourceList(config.kv_namespaces, "kv");
  list(config.secrets, "secret", "value withheld — set with `sproutboat secrets`");
  resourceList(config.d1_databases, "d1");
  resourceList(config.r2_buckets, "r2");
  resourceList(config.queues, "queue");
  list(config.analytics_engine_datasets, "analytics");
  for (const [name, className] of Object.entries(config.durable_objects ?? {}))
    rows.push([`env.${name}`, "durable object", className]);
  for (const host of config.outbound ?? []) rows.push([`fetch()`, "outbound", host]);
  for (const cron of config.triggers?.crons ?? []) rows.push([`scheduled()`, "cron", cron]);
  if (config.assets?.binding) rows.push([`env.${config.assets.binding}`, "assets", config.assets.directory ?? ""]);
  return rows;
}

/**
 * Wrangler-shaped build/deploy summary: what the artifact contains, its upload
 * size, and every binding the handler will see. Returns nothing.
 */
export function printDeployReport(
  config: SproutboatConfig,
  manifest: ArtifactManifest,
  sproutBin: Uint8Array,
  manifestBytes: number,
): void {
  const gz = gzipSync(Uint8Array.from(sproutBin)).length;
  const total = sproutBin.length + manifestBytes;

  console.log(`\n${sprout("🌱")} ${bold(leaf(`sproutboat ${CLI_VERSION}`))}`);
  console.log(leaf("─".repeat(19)));
  console.log(`Compiled ${bold(manifest.project)} with Porffor ${manifest.porfforVersion}`);
  console.log(dim(`  toolchain  ${manifest.buildImage}`));
  console.log(dim(`  compat     ${config.compatibility_date}`));
  console.log();

  console.log(bold("Artifact"));
  console.log(
    table(
      ["File", "Type", "Size"],
      [
        ["sprout", manifest.runtime, bytes(sproutBin.length)],
        ["manifest.json", "json", bytes(manifestBytes)],
      ],
      [false, false, true],
    ),
  );
  console.log(`Total upload: ${bold(bytes(total))}  ${dim(`(sprout gzip: ${bytes(gz)})`)}`);
  console.log();

  const rows = bindingRows(config);
  console.log(bold("Bindings the handler will see"));
  if (rows.length === 0) {
    console.log(dim("  (none — add vars / kv_namespaces / secrets / … to sproutboat.jsonc)"));
  } else {
    console.log(table(["Binding", "Type", "Detail"], rows));
  }
}
