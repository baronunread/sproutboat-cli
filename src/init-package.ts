import { existsSync } from "node:fs";
import { join } from "node:path";
import { jsonObject, parseJsonValue, type JsonObject } from "./json";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// Same conventions as Wrangler's create-cloudflare templates: a private
// package at 0.0.0, `dev`, `deploy` and `check` scripts, and the CLI as a
// devDependency.
export const INIT_SCRIPTS = {
  dev: "sproutboat dev",
  deploy: "sproutboat deploy",
  check: "sproutboat check",
} as const satisfies Record<string, string>;

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** A lockfile in the project wins; otherwise the tool that launched the CLI; otherwise npm. */
export function detectPackageManager(directory: string, userAgent = process.env.npm_config_user_agent): PackageManager {
  for (const [file, manager] of LOCKFILES) if (existsSync(join(directory, file))) return manager;
  const agent = /^(npm|pnpm|yarn|bun)\//.exec(userAgent ?? "")?.[1];
  return agent === "pnpm" || agent === "yarn" || agent === "bun" ? agent : "npm";
}

export function installCommand(manager: PackageManager): string {
  return `${manager} install`;
}

export function runScriptCommand(manager: PackageManager, script: string): string {
  // Only yarn can drop `run` for every script. `pnpm deploy` is pnpm's own
  // workspace command, so the script has to be `pnpm run deploy`.
  return manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`;
}

export type PackagePlan = {
  /** Serialized package.json to write. */
  text: string;
  created: boolean;
  addedDependency: boolean;
  addedScripts: string[];
  /** Existing scripts left alone because the name was taken. */
  skippedScripts: string[];
};

/** Throws on a package.json that is not a JSON object, before anything is written. */
export function planPackageJson(name: string, existing: string | undefined, cliVersion: string): PackagePlan {
  const range = `^${cliVersion}`;
  let pkg: JsonObject;
  let indent: string | number = 2;
  let created = false;
  if (existing === undefined) {
    created = true;
    pkg = { name, version: "0.0.0", private: true };
  } else {
    let parsed: JsonObject | undefined;
    try {
      parsed = jsonObject(parseJsonValue(existing));
    } catch {
      parsed = undefined;
    }
    if (!parsed) throw new Error("package.json is not a valid JSON object, so init did not touch it");
    pkg = parsed;
    indent = /^[ \t]+(?=")/m.exec(existing)?.[0] ?? 2;
  }

  const scripts: JsonObject = jsonObject(pkg.scripts) ?? {};
  const addedScripts: string[] = [];
  const skippedScripts: string[] = [];
  for (const [script, command] of Object.entries(INIT_SCRIPTS)) {
    if (!(script in scripts)) {
      scripts[script] = command;
      addedScripts.push(script);
    } else if (scripts[script] !== command) skippedScripts.push(script);
  }
  if (addedScripts.length > 0) pkg.scripts = scripts;

  const devDependencies: JsonObject = jsonObject(pkg.devDependencies) ?? {};
  // Already declared anywhere: the project chose its own range.
  const declared = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies].some(
    (section) => jsonObject(section)?.sproutboat !== undefined,
  );
  const addedDependency = !declared;
  if (addedDependency) {
    devDependencies.sproutboat = range;
    pkg.devDependencies = Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b)));
  }
  return {
    text: `${JSON.stringify(pkg, null, indent)}\n`,
    created,
    addedDependency,
    addedScripts,
    skippedScripts,
  };
}
