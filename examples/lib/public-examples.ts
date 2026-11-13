/**
 * Which directories under examples/ are examples, as opposed to fixtures.
 *
 * An example is read by people and held to the rules in README.md; a fixture exists for a test or a measurement and
 * is exempt. The list of fixtures is here so the runners and `src/examples-rules.test.ts` agree on it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const EXAMPLES_DIR = join(import.meta.dir, "..");

/** Directories under examples/ that are not examples. */
export const FIXTURES: ReadonlySet<string> = new Set([
  "conformance",
  "lib",
  "node_modules",
  "runtime-comparison",
  "showcase",
  "stress",
  "workers-contract",
  "workers-verbatim",
]);

/** An example's `sproutboat.jsonc` directory, by its name relative to examples/ (`service-bindings/caller`). */
export function publicExamples(root: string = EXAMPLES_DIR): string[] {
  const found: string[] = [];
  const visit = (relative: string, depth: number) => {
    const dir = join(root, relative);
    if (existsSync(join(dir, "sproutboat.jsonc"))) {
      found.push(relative);
      return;
    }
    if (depth === 0) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || (depth === 2 && FIXTURES.has(entry.name))) continue;
      visit(relative ? `${relative}/${entry.name}` : entry.name, depth - 1);
    }
  };
  visit("", 2);
  return found.sort();
}
