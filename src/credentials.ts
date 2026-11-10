import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isString, jsonObject } from "./json";

export type EndpointKind = "cloud" | "community";

/** One Cloud team the user is logged in to: an account API key the device login minted. */
export type StoredTeam = { token: string; id: string; name: string; role: string; keyId: string; keyName: string };

/**
 * One endpoint. `token` is always the default team's key (or the only credential of a Community endpoint), so a
 * file written by this version still reads in an older CLI, which looks only at `token`.
 */
export type Profile = { token: string; kind?: EndpointKind; team?: string; teams: Record<string, StoredTeam> };

type Credentials = { version: 1; activeApiUrl?: string; profiles: Record<string, Profile> };

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function str(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined;
}
function obj(value: JsonValue | undefined): JsonObject | undefined {
  return value === undefined ? undefined : jsonObject(value);
}

function parseTeam(value: JsonValue | undefined): StoredTeam | undefined {
  const input = obj(value);
  const token = str(input?.token);
  if (!input || token === undefined) return undefined;
  return {
    token,
    id: str(input.id) ?? "",
    name: str(input.name) ?? "",
    role: str(input.role) ?? "",
    keyId: str(input.keyId) ?? "",
    keyName: str(input.keyName) ?? "",
  };
}

function parseCredentials(value: JsonValue): Credentials | undefined {
  const input = obj(value);
  const rawProfiles = obj(input?.profiles);
  if (!input || input.version !== 1 || !rawProfiles) return undefined;
  const profiles: Record<string, Profile> = {};
  for (const [apiUrl, profileValue] of Object.entries(rawProfiles)) {
    const profile = obj(profileValue);
    const token = str(profile?.token);
    if (!profile || token === undefined) return undefined;
    const teams: Record<string, StoredTeam> = {};
    for (const [slug, teamValue] of Object.entries(obj(profile.teams) ?? {})) {
      const team = parseTeam(teamValue);
      if (team) teams[slug] = team;
    }
    const kind = profile.kind === "cloud" || profile.kind === "community" ? profile.kind : undefined;
    profiles[apiUrl] = { token, kind, team: str(profile.team), teams };
  }
  return { version: 1, activeApiUrl: str(input.activeApiUrl), profiles };
}

/**
 * Where the credentials live, mirroring Wrangler (xdg-app-paths): `SPROUTBOAT_CONFIG_DIR` or an absolute
 * `XDG_CONFIG_HOME` first, else `~/Library/Preferences/sproutboat` on macOS and `~/.config/sproutboat` elsewhere.
 */
export function configDirectory(): string {
  const configured = process.env.SPROUTBOAT_CONFIG_DIR || process.env.XDG_CONFIG_HOME;
  if (configured && isAbsolute(configured)) return resolve(configured, "sproutboat");
  if (platform() === "darwin") return resolve(home(), "Library", "Preferences", "sproutboat");
  return resolve(home(), ".config", "sproutboat");
}

function credentialsPath(): string {
  return resolve(configDirectory(), "credentials.json");
}

/** Earlier versions kept the file in ~/.config/sproutboat on every platform. Read it when the new place has none. */
function legacyCredentialsPath(): string | undefined {
  if (process.env.SPROUTBOAT_CONFIG_DIR || process.env.XDG_CONFIG_HOME) return undefined;
  const legacy = resolve(home(), ".config", "sproutboat", "credentials.json");
  return legacy === credentialsPath() ? undefined : legacy;
}

function emptyCredentials(): Credentials {
  return { version: 1, profiles: {} };
}

async function readFileOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("could not read local Sproutboat credentials");
  }
}

async function readCredentials(): Promise<Credentials> {
  let text = await readFileOrMissing(credentialsPath());
  if (text === undefined) {
    const legacy = legacyCredentialsPath();
    text = legacy === undefined ? undefined : await readFileOrMissing(legacy);
  }
  if (text === undefined) return emptyCredentials();
  try {
    return parseCredentials(JSON.parse(text)) || emptyCredentials();
  } catch {
    throw new Error("could not read local Sproutboat credentials");
  }
}

export async function savedToken(apiUrl: string): Promise<string | undefined> {
  return (await readCredentials()).profiles[apiUrl]?.token;
}

export async function savedProfile(apiUrl: string): Promise<Profile | undefined> {
  return (await readCredentials()).profiles[apiUrl];
}

export async function activeApiUrl(): Promise<string | undefined> {
  return (await readCredentials()).activeApiUrl;
}

/**
 * #79 `logout`: drop one endpoint's credential. With `team`, only that team's key is dropped from a Cloud
 * endpoint; the default moves to a remaining team, and the endpoint goes only when none is left. Returns
 * `removed: false` when nothing matched. baronunread/sproutboat#204: dropping the active endpoint clears it
 * rather than picking another one by object key order.
 */
export async function forgetToken(
  apiUrl: string,
  team?: string,
): Promise<{ removed: boolean; activeApiUrl?: string; remaining: string[] }> {
  const credentials = await readCredentials();
  const profile = credentials.profiles[apiUrl];
  if (!profile) return { removed: false, remaining: [] };
  if (team !== undefined && !profile.teams[team]) return { removed: false, remaining: Object.keys(profile.teams) };
  if (team !== undefined) {
    delete profile.teams[team];
    const left = Object.keys(profile.teams);
    if (left.length > 0) {
      const next = profile.team === team || profile.team === undefined ? left[0]! : profile.team;
      profile.team = next;
      profile.token = profile.teams[next]!.token;
      await writeCredentials(credentials);
      return { removed: true, activeApiUrl: credentials.activeApiUrl, remaining: left };
    }
  }
  delete credentials.profiles[apiUrl];
  if (credentials.activeApiUrl === apiUrl) credentials.activeApiUrl = undefined;
  await writeCredentials(credentials);
  return { removed: true, activeApiUrl: credentials.activeApiUrl, remaining: [] };
}

/**
 * baronunread/sproutboat#204: the machine-wide active endpoint is only set the first time (nothing saved yet);
 * a later login to a second endpoint keeps the existing one and reports it.
 */
export async function saveToken(apiUrl: string, token: string, kind?: EndpointKind): Promise<{ activeApiUrl: string }> {
  const credentials = await readCredentials();
  credentials.profiles[apiUrl] = { token, kind: kind ?? credentials.profiles[apiUrl]?.kind, teams: {} };
  if (!credentials.activeApiUrl) credentials.activeApiUrl = apiUrl;
  await writeCredentials(credentials);
  return { activeApiUrl: credentials.activeApiUrl };
}

/** Store one team's key for a Cloud endpoint. The newest login becomes that endpoint's default team. */
export async function saveTeam(apiUrl: string, slug: string, team: StoredTeam): Promise<{ activeApiUrl: string }> {
  const credentials = await readCredentials();
  const previous = credentials.profiles[apiUrl];
  const teams = { ...previous?.teams, [slug]: team };
  credentials.profiles[apiUrl] = { token: team.token, kind: "cloud", team: slug, teams };
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

/** $HOME when set (as Wrangler's xdg-app-paths does), else the account's home directory. */
function home(): string {
  return process.env.HOME || homedir();
}
