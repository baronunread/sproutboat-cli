/**
 * Which directories hold a Worker that the runners (smoke.ts, workerd.ts, typecheck.ts) and
 * `src/examples-rules.test.ts` hold to the Workers style, and where.
 *
 * `examples/` holds only what a person reads. `dogfood/` holds the apps Sproutboat itself deploys and checks every
 * generation swap with. Everything that exists for a test or a measurement is a fixture under `test/fixtures/`; of
 * those, the ones that are plain Workers (the Cloudflare ports, `request`, `upload`) are checked beside the examples,
 * and the rest (conformance, stress, runtime-comparison, workers-verbatim, workers-contract) are driven by their own
 * harnesses.
 *
 * A project's name is its path under its group's directory, prefixed with the group's name unless the group is
 * `examples`: `kv`, `service-bindings/caller`, `fixtures/cf-json`, `dogfood/kitchen-sink`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "../../..");
export const EXAMPLES_DIR = join(REPO, "examples");
export const FIXTURES_DIR = join(REPO, "test/fixtures");
export const DOGFOOD_DIR = join(REPO, "dogfood");

/** The fixtures that are standard Workers, and so run on workerd and as standalone binaries with the examples. */
export const STANDARD_FIXTURES: readonly string[] = [
  "cf-cookies",
  "cf-headers",
  "cf-json",
  "cf-post",
  "cf-redirects",
  "request",
  "upload",
];

export type Group = "examples" | "dogfood" | "fixtures";
export type Project = { name: string; group: Group; dir: string };

const GROUP_DIRS = { examples: EXAMPLES_DIR, dogfood: DOGFOOD_DIR, fixtures: FIXTURES_DIR } satisfies Record<
  Group,
  string
>;

/** `sproutboat.jsonc` directories under `root`, at most two levels deep (`service-bindings/caller`). */
function configDirs(root: string, only?: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (relative: string, depth: number) => {
    const dir = join(root, relative);
    if (existsSync(join(dir, "sproutboat.jsonc"))) {
      found.push(relative);
      return;
    }
    if (depth === 0 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (relative === "" && only && !only.includes(entry.name)) continue;
      visit(relative ? `${relative}/${entry.name}` : entry.name, depth - 1);
    }
  };
  visit("", 2);
  return found;
}

/** Every project the runners know, sorted by name. */
export function projects(): Project[] {
  const all: Project[] = [];
  for (const relative of configDirs(EXAMPLES_DIR))
    all.push({ name: relative, group: "examples", dir: join(EXAMPLES_DIR, relative) });
  for (const relative of configDirs(DOGFOOD_DIR))
    all.push({ name: `dogfood/${relative}`, group: "dogfood", dir: join(DOGFOOD_DIR, relative) });
  for (const relative of configDirs(FIXTURES_DIR, STANDARD_FIXTURES))
    all.push({ name: `fixtures/${relative}`, group: "fixtures", dir: join(FIXTURES_DIR, relative) });
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export const projectNames = (): string[] => projects().map((project) => project.name);

/** The directory of a project, by name. */
export function projectDir(name: string): string {
  const found = projects().find((project) => project.name === name);
  if (!found) throw new Error(`no such project: ${name}`);
  return found.dir;
}

/** The directory that holds a group's `node_modules` (see typecheck.ts, which links the CLI there). */
export const groupRoots = (): string[] => Object.values(GROUP_DIRS);
