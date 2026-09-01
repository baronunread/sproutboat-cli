import { readFileSync } from "node:fs";
import { gzipSync } from "bun";
import type { SproutboatConfig } from "./config";
import type { ArtifactManifest } from "./manifest";

// Read from package.json so the banner never drifts from the published version.
const CLI_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kib = n / 1024;
  if (kib < 1024) return `${kib.toFixed(2)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
}

/** Minimal box table. `align` marks columns to right-pad-left (numbers). */
function table(headers: string[], rows: string[][], align: boolean[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const row = (cells: string[]) =>
    "│ " + cells.map((c, i) => (align[i] ? (c ?? "").padStart(widths[i]) : (c ?? "").padEnd(widths[i]))).join(" │ ") + " │";
  return [line("┌", "┬", "┐"), row(headers), line("├", "┼", "┤"), ...rows.map(row), line("└", "┴", "┘")].join("\n");
}

/**
 * Wrangler-shaped build/deploy summary. Prints what the artifact contains, its
 * upload size, and the bindings the handler will see. Returns nothing.
 */
export function printDeployReport(
  config: SproutboatConfig,
  manifest: ArtifactManifest,
  sprout: Uint8Array,
  manifestBytes: number,
): void {
  const gz = gzipSync(Uint8Array.from(sprout)).length;
  const total = sprout.length + manifestBytes;

  console.log(`\n🌱 sproutboat ${CLI_VERSION}`);
  console.log("─".repeat(19));
  console.log(`Compiled ${manifest.project} with Porffor ${manifest.porfforVersion}`);
  console.log(`  toolchain  ${manifest.buildImage}`);
  console.log(`  compat     ${config.compatibility_date}`);
  console.log();

  console.log("Artifact:");
  console.log(table(
    ["File", "Type", "Size"],
    [
      ["sprout", manifest.runtime, bytes(sprout.length)],
      ["manifest.json", "json", bytes(manifestBytes)],
    ],
    [false, false, true],
  ));
  console.log(`Total upload: ${bytes(total)}  (sprout gzip: ${bytes(gz)})`);
  console.log();

  const vars = Object.entries(config.vars ?? {});
  console.log("Bindings the handler will see:");
  if (vars.length === 0) {
    console.log("  (none — add [vars] to sproutboat.jsonc)");
  } else {
    console.log(table(
      ["Binding", "Type", "Value"],
      vars.map(([k, v]) => [`env.${k}`, "var", JSON.stringify(v)]),
    ));
  }
}
