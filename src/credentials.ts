import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isString, jsonObject } from "./json";

export type EndpointKind = "cloud" | "community";

/** One Cloud team the user is logged in to: an account API key the device login minted. */
export type StoredTeam = { token: string; id: string; name: string; role: string; keyId: string; keyName: string };

/**
 * One named profile: an endpoint, the credential stored for it and the default team. `token` is the default
 * team's key (or the only credential of a Community endpoint).
 */
export type Profile = {
  apiUrl: string;
  token: string;
  kind?: EndpointKind;
  team?: string;
  teams: Record<string, StoredTeam>;
};

/**
 * Version 2 keys the profiles by name. Version 1 (every release up to 0.53) keyed them by endpoint URL and kept a
 * machine-wide `activeApiUrl`; reading one converts it with `migrateV1`, and the file is rewritten as version 2
 * (after saving the old one as `credentials.v1.json`) the first time anything is saved or forgotten.
 */
type Credentials = { version: 2; activeProfile?: string; profiles: Record<string, Profile> };

/** The profile an existing machine-wide active endpoint becomes. */
export const DEFAULT_PROFILE = "default";
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

function parseProfile(profile: JsonObject | undefined, apiUrl: string | undefined): Profile | undefined {
  const token = str(profile?.token);
  if (!profile || token === undefined || apiUrl === undefined) return undefined;
  const teams: Record<string, StoredTeam> = {};
  for (const [slug, teamValue] of Object.entries(obj(profile.teams) ?? {})) {
    const team = parseTeam(teamValue);
    if (team) teams[slug] = team;
  }
  const kind = profile.kind === "cloud" || profile.kind === "community" ? profile.kind : undefined;
  return { apiUrl, token, kind, team: str(profile.team), teams };
}

/** A name for an endpoint that has none: its host, as `dash.sproutboat.com` or `localhost-8787`. */
export function profileNameForUrl(apiUrl: string, taken: ReadonlySet<string>): string {
  let base: string;
  try {
    base = new URL(apiUrl).host;
  } catch {
    base = apiUrl;
  }
  base =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 60) || "endpoint";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

/**
 * Today's credentials become profiles. The active endpoint is the `default` profile; every other stored
 * endpoint is named after its host. Nothing is dropped and nothing is repointed: with no active endpoint there is
 * no default profile, as before.
 */
export function migrateV1(activeApiUrl: string | undefined, byUrl: Record<string, Profile>): Credentials {
  const profiles: Record<string, Profile> = {};
  let activeProfile: string | undefined;
  if (activeApiUrl !== undefined && byUrl[activeApiUrl]) {
    profiles[DEFAULT_PROFILE] = byUrl[activeApiUrl];
    activeProfile = DEFAULT_PROFILE;
  }
  for (const [apiUrl, profile] of Object.entries(byUrl)) {
    if (apiUrl === activeApiUrl && activeProfile !== undefined) continue;
    profiles[profileNameForUrl(apiUrl, new Set(Object.keys(profiles)))] = profile;
  }
  return { version: 2, activeProfile, profiles };
}

function parseCredentials(value: JsonValue): { credentials: Credentials; migrated: boolean } | undefined {
  const input = obj(value);
  const rawProfiles = obj(input?.profiles);
  if (!input || !rawProfiles) return undefined;
  const profiles: Record<string, Profile> = {};
  if (input.version === 1) {
    for (const [apiUrl, profileValue] of Object.entries(rawProfiles)) {
      const profile = parseProfile(obj(profileValue), apiUrl);
      if (!profile) return undefined;
      profiles[apiUrl] = profile;
    }
    return { credentials: migrateV1(str(input.activeApiUrl), profiles), migrated: true };
  }
  if (input.version !== 2) return undefined;
  for (const [name, profileValue] of Object.entries(rawProfiles)) {
    const profileObject = obj(profileValue);
    const profile = parseProfile(profileObject, str(profileObject?.apiUrl));
    if (!profile) return undefined;
    profiles[name] = profile;
  }
  const active = str(input.activeProfile);
  return {
    credentials: { version: 2, activeProfile: active !== undefined && profiles[active] ? active : undefined, profiles },
    migrated: false,
  };
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
  return { version: 2, profiles: {} };
}

async function readFileOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("could not read local Sproutboat credentials");
  }
}

/** What is on disk. `legacyText` is set when it was a version 1 file, so the first write can keep a copy. */
type Loaded = { credentials: Credentials; legacyText?: string };

async function readCredentials(): Promise<Loaded> {
  let text = await readFileOrMissing(credentialsPath());
  if (text === undefined) {
    const legacy = legacyCredentialsPath();
    text = legacy === undefined ? undefined : await readFileOrMissing(legacy);
  }
  if (text === undefined) return { credentials: emptyCredentials() };
  try {
    const parsed = parseCredentials(JSON.parse(text));
    if (!parsed) return { credentials: emptyCredentials() };
    return { credentials: parsed.credentials, legacyText: parsed.migrated ? text : undefined };
  } catch {
    throw new Error("could not read local Sproutboat credentials");
  }
}

/**
 * The profile chosen with `--profile` or `SPROUTBOAT_PROFILE` for this run, set by `main.ts`. Every lookup and
 * write below goes to it; with none chosen they find a profile by endpoint (the active one first), and a login to
 * an endpoint nothing is stored for makes a new profile.
 */
let selected: string | undefined;

export function selectProfile(name: string | undefined): void {
  selected = name;
}

const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");

/** The stored profile for an endpoint: the selected one, else the active one, else the first one on that URL. */
function findProfile(credentials: Credentials, apiUrl: string): { name: string; profile: Profile } | undefined {
  if (selected !== undefined) {
    const profile = credentials.profiles[selected];
    return profile && sameUrl(profile.apiUrl, apiUrl) ? { name: selected, profile } : undefined;
  }
  const active = credentials.activeProfile;
  if (active !== undefined && sameUrl(credentials.profiles[active].apiUrl, apiUrl))
    return { name: active, profile: credentials.profiles[active] };
  const found = Object.entries(credentials.profiles).find(([, profile]) => sameUrl(profile.apiUrl, apiUrl));
  return found ? { name: found[0], profile: found[1] } : undefined;
}

/** Where a save for `apiUrl` goes: the selected profile, the profile already on that URL, or a new one. */
function writeTarget(credentials: Credentials, apiUrl: string): string {
  if (selected !== undefined) {
    const existing = credentials.profiles[selected];
    if (existing && !sameUrl(existing.apiUrl, apiUrl))
      throw new Error(
        `the profile "${selected}" is for ${existing.apiUrl}, not ${apiUrl}; log out of it first, or use another profile name`,
      );
    return selected;
  }
  const found = findProfile(credentials, apiUrl);
  if (found) return found.name;
  const names = Object.keys(credentials.profiles);
  return names.length === 0 ? DEFAULT_PROFILE : profileNameForUrl(apiUrl, new Set(names));
}

/** The first profile ever saved is the active one; a later login keeps it, and so does a failed one (#204). */
function activateIfNone(credentials: Credentials, name: string): void {
  if (credentials.activeProfile === undefined || !credentials.profiles[credentials.activeProfile])
    credentials.activeProfile = name;
}

export type ProfileSummary = { name: string; active: boolean; profile: Profile };

export async function listProfiles(): Promise<ProfileSummary[]> {
  const { credentials } = await readCredentials();
  return Object.entries(credentials.profiles).map(([name, profile]) => ({
    name,
    active: name === credentials.activeProfile,
    profile,
  }));
}

export async function getProfile(name: string): Promise<Profile | undefined> {
  return (await readCredentials()).credentials.profiles[name];
}

/** The machine's default profile: what a command uses when nothing names another one. */
export async function activeProfileName(): Promise<string | undefined> {
  return (await readCredentials()).credentials.activeProfile;
}

/** `profile use`: make `name` the default profile. False when there is no such profile. */
export async function useProfile(name: string): Promise<boolean> {
  const { credentials, legacyText } = await readCredentials();
  if (!credentials.profiles[name]) return false;
  credentials.activeProfile = name;
  await writeCredentials(credentials, legacyText);
  return true;
}

/** The name of the profile a command would use for this endpoint, if one is stored. */
export async function savedProfileName(apiUrl: string): Promise<string | undefined> {
  return findProfile((await readCredentials()).credentials, apiUrl)?.name;
}

export async function savedToken(apiUrl: string): Promise<string | undefined> {
  return findProfile((await readCredentials()).credentials, apiUrl)?.profile.token;
}

export async function savedProfile(apiUrl: string): Promise<Profile | undefined> {
  return findProfile((await readCredentials()).credentials, apiUrl)?.profile;
}

/** The endpoint of the machine's default profile. */
export async function activeApiUrl(): Promise<string | undefined> {
  const { credentials } = await readCredentials();
  return credentials.activeProfile === undefined ? undefined : credentials.profiles[credentials.activeProfile].apiUrl;
}

/**
 * #79 `logout`: drop one endpoint's credential (the selected profile's, if one is selected). With `team`, only
 * that team's key is dropped from a Cloud profile; the default moves to a remaining team, and the profile goes only
 * when none is left. Returns `removed: false` when nothing matched. baronunread/sproutboat#204: dropping the
 * active profile clears it rather than picking another one by object key order.
 */
export async function forgetToken(
  apiUrl: string,
  team?: string,
): Promise<{ removed: boolean; activeApiUrl?: string; remaining: string[] }> {
  const { credentials, legacyText } = await readCredentials();
  const found = findProfile(credentials, apiUrl);
  const activeUrl = () =>
    credentials.activeProfile === undefined ? undefined : credentials.profiles[credentials.activeProfile]?.apiUrl;
  if (!found) return { removed: false, remaining: [] };
  const { name, profile } = found;
  if (team !== undefined && !profile.teams[team]) return { removed: false, remaining: Object.keys(profile.teams) };
  if (team !== undefined) {
    delete profile.teams[team];
    const left = Object.keys(profile.teams);
    if (left.length > 0) {
      const next = profile.team === team || profile.team === undefined ? left[0]! : profile.team;
      profile.team = next;
      profile.token = profile.teams[next]!.token;
      await writeCredentials(credentials, legacyText);
      return { removed: true, activeApiUrl: activeUrl(), remaining: left };
    }
  }
  delete credentials.profiles[name];
  if (credentials.activeProfile === name) credentials.activeProfile = undefined;
  await writeCredentials(credentials, legacyText);
  return { removed: true, activeApiUrl: activeUrl(), remaining: [] };
}

export type SaveResult = { activeApiUrl: string; profile: string; activeProfile: string };

function saved(credentials: Credentials, profile: string): SaveResult {
  const activeProfile = credentials.activeProfile!;
  return { activeApiUrl: credentials.profiles[activeProfile].apiUrl, profile, activeProfile };
}

/**
 * baronunread/sproutboat#204: the machine's default profile is only set the first time (nothing saved yet);
 * a later login to a second endpoint keeps the existing one and reports it.
 */
export async function saveToken(apiUrl: string, token: string, kind?: EndpointKind): Promise<SaveResult> {
  const { credentials, legacyText } = await readCredentials();
  const name = writeTarget(credentials, apiUrl);
  credentials.profiles[name] = { apiUrl, token, kind: kind ?? credentials.profiles[name]?.kind, teams: {} };
  activateIfNone(credentials, name);
  await writeCredentials(credentials, legacyText);
  return saved(credentials, name);
}

/** Store one team's key for a Cloud profile. The newest login becomes that profile's default team. */
export async function saveTeam(apiUrl: string, slug: string, team: StoredTeam): Promise<SaveResult> {
  const { credentials, legacyText } = await readCredentials();
  const name = writeTarget(credentials, apiUrl);
  const teams = { ...credentials.profiles[name]?.teams, [slug]: team };
  credentials.profiles[name] = { apiUrl, token: team.token, kind: "cloud", team: slug, teams };
  activateIfNone(credentials, name);
  await writeCredentials(credentials, legacyText);
  return saved(credentials, name);
}

/** Atomic 0600 write of the whole credentials file. */
async function writeCredentials(credentials: Credentials, legacyText?: string): Promise<void> {
  const directory = configDirectory();
  const path = credentialsPath();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // The first write of a version 2 file keeps the version 1 one, which an older CLI can still read.
  if (legacyText !== undefined) {
    try {
      await writeFile(resolve(directory, "credentials.v1.json"), legacyText, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
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
