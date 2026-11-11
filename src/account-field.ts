import { parseConfig, type ConfigValidation } from "./config";
import { isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";

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

const MIGRATIONS_DIR_ERROR = 'migrations_dir must be a relative folder inside the project (for example "migrations")';
const validMigrationsDir = (dir: JsonValue | undefined): boolean =>
  isString(dir) && dir !== "" && !dir.startsWith("/") && !/^[A-Za-z]:/.test(dir) && !dir.split(/[\\/]/).includes("..");

/**
 * parseConfig for a file that may carry the CLI-owned fields `account` and `migrations_dir`: they are validated here and
 * removed before the shared schema sees them.
 */
export function parseProjectConfig(source: string): ConfigValidation {
  const loose = parseLoose(source);
  if (loose === undefined || !("account" in loose || "migrations_dir" in loose)) return parseConfig(source);
  const errors: string[] = [];
  if ("account" in loose && (!isString(loose.account) || !ACCOUNT_RE.test(loose.account)))
    errors.push("account must be the URL name of a team (lowercase letters, digits and dashes)");
  if ("migrations_dir" in loose && !validMigrationsDir(loose.migrations_dir)) errors.push(MIGRATIONS_DIR_ERROR);
  if (errors.length > 0) return { ok: false, errors };
  const rest = Object.fromEntries(
    Object.entries(loose).filter(([key]) => key !== "account" && key !== "migrations_dir"),
  );
  return parseConfig(JSON.stringify(rest));
}
