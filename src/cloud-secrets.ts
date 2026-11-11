/**
 * Secrets on the Sproutboat Cloud, Wrangler style: `secrets put/list/delete` act on the deployed app by name, and a
 * deploy never wipes them. The Cloud routes: GET /v1/apps/<app>/secrets, PUT and DELETE /v1/apps/<app>/secrets/<NAME>.
 */
import { readEnvFile } from "./env-file";
import { CloudError } from "./cloud";
import { makeCall, type CloudCredentials } from "./cloud-deploy";
import { isSafeInteger, isString } from "./json";

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

type SecretAction = "list" | "write";
const PERMISSION = { list: "secret:list", write: "secret:write" } as const satisfies Record<SecretAction, string>;

const notDeployed = (project: string) =>
  `${project} is not deployed yet, so it has nowhere to keep secrets: run \`sproutboat deploy\` first, or pass them on the first deploy with --secrets-file <file>`;

/** One call; the 403 and the missing app become sentences of their own. */
async function secretCall(
  credentials: CloudCredentials,
  project: string,
  action: SecretAction,
  c: { method: string; path: string; json?: object },
  missingSecret?: string,
) {
  const result = await makeCall(credentials)({ ...c, ok: [403, 404] });
  if (result.status === 403)
    throw new CloudError(
      `this key lacks the ${PERMISSION[action]} permission; ask a team Owner or Admin, or use a key that has it (see \`sproutboat whoami\` for this key's access)`,
    );
  if (result.status === 404) {
    const error = result.body?.error;
    if (missingSecret !== undefined && isString(error) && error !== "no such app")
      throw new CloudError(`${project} has no secret named ${missingSecret}`);
    throw new CloudError(notDeployed(project));
  }
  return result;
}

export async function listCloudSecrets(credentials: CloudCredentials, project: string): Promise<string[]> {
  const result = await secretCall(credentials, project, "list", {
    method: "GET",
    path: `/v1/apps/${project}/secrets`,
  });
  const names = result.body?.secrets;
  return Array.isArray(names) ? names.filter(isString) : [];
}

/** Returns the record generation the write produced. */
export async function putCloudSecret(
  credentials: CloudCredentials,
  project: string,
  name: string,
  value: string,
): Promise<number | undefined> {
  const result = await secretCall(credentials, project, "write", {
    method: "PUT",
    path: `/v1/apps/${project}/secrets/${name}`,
    json: { value },
  });
  const generation = result.body?.record_generation;
  return isSafeInteger(generation) ? generation : undefined;
}

type SecretsPatchBody = { set?: Record<string, string>; delete?: string[] };

/** One PATCH that sets and deletes many secrets at once; returns the record generation it produced. */
export async function patchCloudSecrets(
  credentials: CloudCredentials,
  project: string,
  patch: { set: Record<string, string>; delete: string[] },
): Promise<number | undefined> {
  const body: SecretsPatchBody = {};
  if (Object.keys(patch.set).length > 0) body.set = patch.set;
  if (patch.delete.length > 0) body.delete = patch.delete;
  const result = await secretCall(credentials, project, "write", {
    method: "PATCH",
    path: `/v1/apps/${project}/secrets`,
    json: body,
  });
  const generation = result.body?.record_generation;
  return isSafeInteger(generation) ? generation : undefined;
}

export async function deleteCloudSecret(
  credentials: CloudCredentials,
  project: string,
  name: string,
): Promise<number | undefined> {
  const result = await secretCall(
    credentials,
    project,
    "write",
    { method: "DELETE", path: `/v1/apps/${project}/secrets/${name}` },
    name,
  );
  const generation = result.body?.record_generation;
  return isSafeInteger(generation) ? generation : undefined;
}

/**
 * The values of `deploy --secrets-file <file>`: a `.dev.vars` or `.env` file, read with `dev`'s dotenv parser. Only the
 * file named is read; `.dev.vars` is never picked up implicitly on a deploy, as with the Community deploy. Names
 * only in every message.
 */
export async function readSecretsFile(path: string): Promise<{ values: Record<string, string>; warnings: string[] }> {
  const parsed = await readEnvFile(path);
  const values: Record<string, string> = {};
  const bad: string[] = [];
  const skipped: string[] = [];
  for (const entry of parsed.entries) {
    if (!SECRET_NAME_RE.test(entry.key)) bad.push(entry.key);
    else if (entry.value === "") skipped.push(entry.key);
    else values[entry.key] = entry.value;
  }
  if (bad.length > 0)
    throw new CloudError(`${path}: secret names must be UPPER_SNAKE_CASE; not valid: ${bad.join(", ")}`);
  const warnings = [...parsed.warnings];
  if (skipped.length > 0) warnings.push(`${path}: not sent, empty value: ${skipped.join(", ")}`);
  return { values, warnings };
}
