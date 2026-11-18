import { parseConfig, type ConfigValidation } from "./config";
import { isBoolean, isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";

/** Blank out comments and trailing commas the way parseConfig does, then parse. Undefined when it is not a JSON object. */
function parseLoose(source: string): JsonObject | undefined {
  let json = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"' && source[index - 1] !== "\\") quoted = !quoted;
    if (!quoted && character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      json += "\n";
    } else if (!quoted && character === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) return undefined;
      index++;
    } else json += character;
  }
  try {
    return jsonObject(parseJsonValue(json.replace(/,\s*([}\]])/g, "$1")));
  } catch {
    return undefined;
  }
}

const ACCOUNT_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * The `account` field of sproutboat.jsonc (like Wrangler's `account_id`): the Cloud team a deploy targets.
 * It belongs to the CLI, not to the app, so the shared config schema does not know it.
 */
export function configAccount(source: string): string | undefined {
  const account = parseLoose(source)?.account;
  return isString(account) && account !== "" ? account : undefined;
}

/**
 * `migrations_dir` (like Wrangler's, but top level: a Sproutboat app has its D1 databases by binding name only): the
 * directory `d1 migrations` keeps its .sql files in, relative to the project. Defaults to `migrations`. Undefined when
 * absent; an invalid value is reported by parseProjectConfig.
 */
export function configMigrationsDir(source: string): string | undefined {
  const dir = parseLoose(source)?.migrations_dir;
  return isString(dir) && dir !== "" ? dir : undefined;
}

/**
 * `workers_dev` (Wrangler's, with its meaning): whether the app is served on its platform name,
 * `<app>.<team>.sproutboat.app`, the counterpart of the `<worker>.<subdomain>.workers.dev` address. Undefined when the config
 * does not say. A value that is not a boolean is reported by parseProjectConfig.
 */
export function configWorkersDev(source: string): boolean | undefined {
  const value = parseLoose(source)?.workers_dev;
  return isBoolean(value) ? value : undefined;
}

export type WorkersDev = {
  /** Whether a deploy puts the platform name among the app's routes (true) or takes it out (false). */
  enabled: boolean;
  /** Where the value comes from: the config says it, or it is Wrangler's default. */
  from: "config" | "default";
};

/**
 * What a deploy does with the platform name. Wrangler defaults `workers_dev` to true when the config has no `route` or
 * `routes` and to false otherwise. This config has no `route` or `routes` (the schema refuses them), so the default is always
 * true; when they arrive, the default turns false for a config that declares one and an explicit `workers_dev: true` keeps the
 * platform name beside them, exactly as in Wrangler.
 */
export function resolveWorkersDev(declared: boolean | undefined): WorkersDev {
  return declared === undefined ? { enabled: true, from: "default" } : { enabled: declared, from: "config" };
}

const WORKERS_DEV_ERROR = "workers_dev must be true or false";
const MIGRATIONS_DIR_ERROR = 'migrations_dir must be a relative folder inside the project (for example "migrations")';
const validMigrationsDir = (dir: JsonValue | undefined): boolean =>
  isString(dir) && dir !== "" && !dir.startsWith("/") && !/^[A-Za-z]:/.test(dir) && !dir.split(/[\\/]/).includes("..");

/** The `main` a project with assets and no `main` gets: a file that does not exist, written by `readProject` into `.sproutboat/`. */
export const ASSETS_ONLY_MAIN = "src/.assets-only.js";

/**
 * The entry a Worker with only static assets runs, as Wrangler allows (`assets` and no `main`). The platform serves a matching
 * file before any code runs; a request that matches none reaches this, and `env.<binding>.fetch` answers it with the project's
 * `not_found_handling`: the single-page app shell, the nearest 404 page, or a plain 404.
 */
export function assetsOnlySource(binding: string): string {
  return [
    "// Written by sproutboat: this project has `assets` and no `main`, so it is a Worker with only static assets.",
    "export default {",
    "  fetch(request, env) {",
    `    return env.${binding}.fetch(request);`,
    "  },",
    "};",
    "",
  ].join("\n");
}

/** `assets` with a directory and no `main`: the assets-only case. The entry and the binding it calls are filled in. */
function withAssetsOnlyEntry(config: JsonObject): JsonObject {
  const assets = jsonObject(config.assets ?? null);
  if (config.main !== undefined || assets === undefined) return config;
  return { ...config, main: ASSETS_ONLY_MAIN, assets: { ...assets, binding: assets.binding ?? "ASSETS" } };
}

/** The CLI-owned fields: validated here and removed before the shared schema sees them. */
const CLI_FIELDS = ["account", "migrations_dir", "workers_dev"];

/**
 * parseConfig for a file that may carry the CLI-owned fields `account`, `migrations_dir` and `workers_dev`: they are validated
 * here and removed before the shared schema sees them.
 */
export function parseProjectConfig(source: string): ConfigValidation {
  const loose = parseLoose(source);
  if (loose === undefined) return parseConfig(source);
  if (!CLI_FIELDS.some((key) => key in loose)) {
    const filled = withAssetsOnlyEntry(loose);
    return filled === loose ? parseConfig(source) : parseConfig(JSON.stringify(filled));
  }
  const errors: string[] = [];
  if ("account" in loose && (!isString(loose.account) || !ACCOUNT_RE.test(loose.account)))
    errors.push("account must be the URL name of a team (lowercase letters, digits and dashes)");
  if ("migrations_dir" in loose && !validMigrationsDir(loose.migrations_dir)) errors.push(MIGRATIONS_DIR_ERROR);
  if ("workers_dev" in loose && !isBoolean(loose.workers_dev)) errors.push(WORKERS_DEV_ERROR);
  if (errors.length > 0) return { ok: false, errors };
  const rest = Object.fromEntries(Object.entries(loose).filter(([key]) => !CLI_FIELDS.includes(key)));
  return parseConfig(JSON.stringify(withAssetsOnlyEntry(rest)));
}

/**
 * The one line a Cloud deploy prints about the platform name: on or off, and why. `host` is the platform name when the team is
 * known (--prepare-out runs with no team, so it says "the platform name").
 */
export function describePlatformName(workersDev: WorkersDev, file: string, host: string | undefined): string {
  const name = host ?? "the platform name";
  if (workersDev.enabled)
    return `${host === undefined ? "on" : `https://${host}`}  (${
      workersDev.from === "config"
        ? `workers_dev: true in ${file}`
        : "workers_dev is on by default: the config declares no routes"
    })`;
  return `off  (workers_dev: false in ${file}; a deploy removes ${name} and keeps every other route)`;
}
