import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

type Credentials = { version: 1; activeApiUrl?: string; profiles: Record<string, { token: string }> };

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function isString(value: JsonValue | undefined): value is string {
  return value !== undefined && value === String(value);
}

type CredentialsInput = JsonObject;
type ProfileInput = JsonObject;

function parseCredentials(value: JsonValue): Credentials | undefined {
  if (!(value instanceof Object) || Array.isArray(value)) return undefined;
  const input: CredentialsInput = value;
  if (input.version !== 1 || !(input.profiles instanceof Object) || Array.isArray(input.profiles)) return undefined;
  const profiles: Record<string, { token: string }> = {};
  for (const [apiUrl, profileValue] of Object.entries(input.profiles)) {
    if (!(profileValue instanceof Object) || Array.isArray(profileValue)) return undefined;
    const profile: ProfileInput = profileValue;
    if (!isString(profile.token)) return undefined;
    profiles[apiUrl] = { token: profile.token };
  }
  return { version: 1, activeApiUrl: isString(input.activeApiUrl) ? input.activeApiUrl : undefined, profiles };
}

export function configDirectory(): string {
  const configured = process.env.SPROUTBOAT_CONFIG_DIR || process.env.XDG_CONFIG_HOME;
  if (configured && isAbsolute(configured)) return resolve(configured, "sproutboat");
  return resolve(homedir(), ".config", "sproutboat");
}

function credentialsPath(): string {
  return resolve(configDirectory(), "credentials.json");
}

function emptyCredentials(): Credentials {
  return { version: 1, profiles: {} };
}

async function readCredentials(): Promise<Credentials> {
  try {
    return parseCredentials(JSON.parse(await readFile(credentialsPath(), "utf8"))) || emptyCredentials();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyCredentials();
    throw new Error("could not read local Sproutboat credentials");
  }
}

export async function savedToken(apiUrl: string): Promise<string | undefined> {
  return (await readCredentials()).profiles[apiUrl]?.token;
}

export async function activeApiUrl(): Promise<string | undefined> {
  return (await readCredentials()).activeApiUrl;
}

/**
 * #79 `logout`: drop one endpoint's token. Returns `removed: false` when none
 * was stored. baronunread/sproutboat#204 — used to repoint `activeApiUrl` to
 * an arbitrary surviving profile chosen by object key order; now it just
 * clears the active endpoint, so the next command falls through to
 * `resolveApiUrl()`'s documented default instead of a silently-picked one.
 */
export async function forgetToken(apiUrl: string): Promise<{ removed: boolean; activeApiUrl?: string }> {
  const credentials = await readCredentials();
  if (!credentials.profiles[apiUrl]) return { removed: false };
  delete credentials.profiles[apiUrl];
  if (credentials.activeApiUrl === apiUrl) credentials.activeApiUrl = undefined;
  await writeCredentials(credentials);
  return { removed: true, activeApiUrl: credentials.activeApiUrl };
}

/**
 * baronunread/sproutboat#204 — used to unconditionally repoint the
 * machine-wide active endpoint to whatever was just logged into, so logging
 * into a local dev control plane for one project silently became the deploy
 * target for every unrelated project on the machine. Now the active endpoint
 * is only set the first time (nothing saved yet); a later login to a second
 * endpoint keeps the existing active endpoint and reports it, so the caller
 * can say so instead of silently switching.
 */
export async function saveToken(apiUrl: string, token: string): Promise<{ activeApiUrl: string }> {
  const credentials = await readCredentials();
  credentials.profiles[apiUrl] = { token };
  if (!credentials.activeApiUrl) credentials.activeApiUrl = apiUrl;
  await writeCredentials(credentials);
  return { activeApiUrl: credentials.activeApiUrl };
}

/** Atomic 0600 write of the whole credentials file. */
async function writeCredentials(credentials: Credentials): Promise<void> {
  const directory = configDirectory();
  const path = credentialsPath();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}
