import { parseConfig, type ConfigValidation } from "./config";
import { isString, jsonObject, parseJsonValue, type JsonObject } from "./json";

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

/** parseConfig for a file that may carry `account`: the field is validated here and removed before the shared schema sees it. */
export function parseProjectConfig(source: string): ConfigValidation {
  const loose = parseLoose(source);
  if (loose === undefined || !("account" in loose)) return parseConfig(source);
  const account = loose.account;
  if (!isString(account) || !ACCOUNT_RE.test(account))
    return { ok: false, errors: ["account must be the URL name of a team (lowercase letters, digits and dashes)"] };
  const rest = Object.fromEntries(Object.entries(loose).filter(([key]) => key !== "account"));
  return parseConfig(JSON.stringify(rest));
}
