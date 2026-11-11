/**
 * `secret bulk [file]`: the input of Wrangler's command, JSON `{"NAME": "value", "OTHER": null}` (a null deletes) or a
 * `.env` file (`NAME=value`, no deletes), read from the file or from stdin, with at most 100 entries. Names only in every
 * message, never a value.
 */
import { CloudError } from "./cloud";
import { SECRET_NAME_RE } from "./cloud-secrets";
import { parseDotenv } from "./env-file";
import { isString, jsonObject, parseJsonValue } from "./json";

export const BULK_MAX = 100;

export type BulkPlan = { set: Record<string, string>; delete: string[]; warnings: string[] };

export function parseBulkSecrets(text: string, label: string): BulkPlan {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  const warnings: string[] = [];
  const bad: string[] = [];
  if (text.trim().startsWith("{")) {
    let parsed;
    try {
      parsed = jsonObject(parseJsonValue(text));
    } catch {
      throw new CloudError(`${label}: not valid JSON; expected {"NAME": "value", "OTHER": null}`);
    }
    if (!parsed) throw new CloudError(`${label}: expected a JSON object of NAME: value`);
    for (const [name, value] of Object.entries(parsed)) {
      if (!SECRET_NAME_RE.test(name)) bad.push(name);
      else if (value === null) remove.push(name);
      else if (isString(value) && value !== "") set[name] = value;
      else throw new CloudError(`${label}: the value of ${name} must be a non-empty string, or null to delete it`);
    }
  } else {
    const env = parseDotenv(text, label);
    warnings.push(...env.warnings);
    const empty: string[] = [];
    for (const entry of env.entries) {
      if (!SECRET_NAME_RE.test(entry.key)) bad.push(entry.key);
      else if (entry.value === "") empty.push(entry.key);
      else set[entry.key] = entry.value;
    }
    if (empty.length > 0) warnings.push(`${label}: not sent, empty value: ${empty.join(", ")}`);
  }
  if (bad.length > 0)
    throw new CloudError(`${label}: secret names must be UPPER_SNAKE_CASE; not valid: ${bad.join(", ")}`);
  const total = Object.keys(set).length + remove.length;
  if (total === 0) throw new CloudError(`${label}: no secrets to set or delete`);
  if (total > BULK_MAX) throw new CloudError(`${label}: ${total} entries; at most ${BULK_MAX} per command`);
  return { set, delete: remove, warnings };
}
