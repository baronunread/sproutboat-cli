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

/** A profile without its endpoint: what `credentials.json` keeps per endpoint, and what a profile can carry itself. */
type Credential = Omit<Profile, "apiUrl">;

/**
 * Storage. Every CLI up to 0.53 reads `credentials.json` as version 1: `activeApiUrl` plus one credential per
 * endpoint URL. That file keeps exactly that shape forever, so a project that still has an older CLI pinned keeps
 * authenticating after the newest CLI logs in, logs out or switches profile. Profiles are a second file next to it,
 * `profiles.json`: a name, the endpoint, and (only when the profile is not the one `credentials.json` holds for that
 * endpoint) its own credential. Tokens are never copied between the files.
 *
 * In memory every profile has its full credential; `holders` says which profile each endpoint's entry in
 * `credentials.json` belongs to (the one most recently saved or switched to on that endpoint).
 */
type Credentials = { activeProfile?: string; profiles: Record<string, Profile>; holders: Record<string, string> };

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

function parseCredential(value: JsonValue | undefined): Credential | undefined {
  const input = obj(value);
  const token = str(input?.token);
  if (!input || token === undefined) return undefined;
  const teams: Record<string, StoredTeam> = {};
  for (const [slug, teamValue] of Object.entries(obj(input.teams) ?? {})) {
    const team = parseTeam(teamValue);
    if (team) teams[slug] = team;
  }
  const kind = input.kind === "cloud" || input.kind === "community" ? input.kind : undefined;
  return { token, kind, team: str(input.team), teams };
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

/** The version 1 file as an older CLI reads it. */
type V1 = { activeApiUrl?: string; endpoints: Record<string, Credential> };
/** `profiles.json`: `credential` is absent for the profile that `credentials.json` holds for its endpoint. */
type ProfilesFile = { activeProfile?: string; profiles: Record<string, { endpoint: string; credential?: Credential }> };

/**
 * Today's credentials become profiles. The active endpoint is the `default` profile; every other stored
 * endpoint is named after its host. Nothing is dropped and nothing is repointed: with no active endpoint there is
 * no default profile, as before.
 */
export function migrateV1(activeApiUrl: string | undefined, byUrl: Record<string, Profile>): Credentials {
  const profiles: Record<string, Profile> = {};
  const holders: Record<string, string> = {};
  let activeProfile: string | undefined;
  if (activeApiUrl !== undefined && byUrl[activeApiUrl]) {
    profiles[DEFAULT_PROFILE] = byUrl[activeApiUrl];
    holders[activeApiUrl] = DEFAULT_PROFILE;
    activeProfile = DEFAULT_PROFILE;
  }
  for (const [apiUrl, profile] of Object.entries(byUrl)) {
    if (apiUrl === activeApiUrl && activeProfile !== undefined) continue;
    const name = profileNameForUrl(apiUrl, new Set(Object.keys(profiles)));
    profiles[name] = profile;
    holders[apiUrl] = name;
  }
  return { activeProfile, profiles, holders };
}

function parseV1(input: JsonObject, rawProfiles: JsonObject): V1 | undefined {
  const endpoints: Record<string, Credential> = {};
  for (const [apiUrl, value] of Object.entries(rawProfiles)) {
    const credential = parseCredential(value);
    if (!credential) return undefined;
    endpoints[apiUrl] = credential;
  }
  return { activeApiUrl: str(input.activeApiUrl), endpoints };
}

function parseProfilesFile(text: string | undefined): ProfilesFile | undefined {
  if (text === undefined) return undefined;
  let input: JsonObject | undefined;
  try {
    input = obj(JSON.parse(text));
  } catch {
    return undefined; // unreadable names only: the credentials themselves are in credentials.json
  }
  const raw = obj(input?.profiles);
  if (!input || input.version !== 1 || !raw) return undefined;
  const profiles: ProfilesFile["profiles"] = {};
  for (const [name, value] of Object.entries(raw)) {
    const entry = obj(value);
    const endpoint = str(entry?.endpoint);
    if (!entry || endpoint === undefined) continue;
    profiles[name] = { endpoint, credential: parseCredential(entry.credential) };
  }
  return { activeProfile: str(input.activeProfile), profiles };
}

/** Put the endpoint credentials of `credentials.json` and the profiles of `profiles.json` together. */
function combine(v1: V1, file: ProfilesFile | undefined): Credentials {
  if (file === undefined || Object.keys(file.profiles).length === 0) {
    const byUrl: Record<string, Profile> = {};
    for (const [apiUrl, credential] of Object.entries(v1.endpoints)) byUrl[apiUrl] = { apiUrl, ...credential };
    return migrateV1(v1.activeApiUrl, byUrl);
  }
  const profiles: Record<string, Profile> = {};
  const holders: Record<string, string> = {};
  for (const [name, entry] of Object.entries(file.profiles)) {
    if (entry.credential) {
      profiles[name] = { apiUrl: entry.endpoint, ...entry.credential };
      continue;
    }
    const held = v1.endpoints[entry.endpoint];
    if (!held) continue; // an older CLI logged out of that endpoint
    profiles[name] = { apiUrl: entry.endpoint, ...held };
    holders[entry.endpoint] ??= name;
  }
  // An endpoint stored by an older CLI after `profiles.json` was written has no profile yet.
  for (const [apiUrl, credential] of Object.entries(v1.endpoints)) {
    if (holders[apiUrl] !== undefined) continue;
    const name = profileNameForUrl(apiUrl, new Set(Object.keys(profiles)));
    profiles[name] = { apiUrl, ...credential };
    holders[apiUrl] = name;
  }
  // The version 1 file owns "which endpoint is active" (an older CLI changes it); the name only picks among profiles.
  let activeProfile: string | undefined;
  if (v1.activeApiUrl !== undefined) {
    const named = file.activeProfile === undefined ? undefined : profiles[file.activeProfile];
    if (named && named.apiUrl === v1.activeApiUrl) activeProfile = file.activeProfile;
    else
      activeProfile =
        holders[v1.activeApiUrl] ?? Object.keys(profiles).find((name) => profiles[name]!.apiUrl === v1.activeApiUrl);
  }
  return { activeProfile, profiles, holders };
}

/** Version 2 as pre-release builds of this change wrote it: profiles keyed by name in `credentials.json`. */
function parsePreRelease(input: JsonObject, rawProfiles: JsonObject): Credentials | undefined {
  const profiles: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(rawProfiles)) {
    const entry = obj(value);
    const credential = parseCredential(entry);
    const apiUrl = str(entry?.apiUrl);
    if (!credential || apiUrl === undefined) return undefined;
    profiles[name] = { apiUrl, ...credential };
  }
  const active = str(input.activeProfile);
  const activeProfile = active !== undefined && profiles[active] ? active : undefined;
  return {
    activeProfile,
    profiles,
    holders: activeProfile === undefined ? {} : { [profiles[activeProfile].apiUrl]: activeProfile },
  };
}

type Parsed = { credentials: Credentials; preRelease: boolean };

function parseFiles(value: JsonValue, profilesText: string | undefined): Parsed | undefined {
  const input = obj(value);
  const rawProfiles = obj(input?.profiles);
  if (!input || !rawProfiles) return undefined;
  if (input.version === 1) {
    const v1 = parseV1(input, rawProfiles);
    return v1 && { credentials: combine(v1, parseProfilesFile(profilesText)), preRelease: false };
  }
  if (input.version !== 2) return undefined;
  const credentials = parsePreRelease(input, rawProfiles);
  return credentials && { credentials, preRelease: true };
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

function profilesPath(): string {
  return resolve(configDirectory(), "profiles.json");
}

function emptyCredentials(): Credentials {
  return { profiles: {}, holders: {} };
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
  // profiles.json only ever sits next to the credentials.json that is in use; the old macOS place never had one.
  let profilesText = text === undefined ? undefined : await readFileOrMissing(profilesPath());
  if (text === undefined) {
    const legacy = legacyCredentialsPath();
    text = legacy === undefined ? undefined : await readFileOrMissing(legacy);
    profilesText = undefined;
  }
  if (text === undefined) return emptyCredentials();
  let parsed: Parsed | undefined;
  try {
    parsed = parseFiles(JSON.parse(text), profilesText);
  } catch {
    throw new Error("could not read local Sproutboat credentials");
  }
  if (!parsed) return emptyCredentials();
  if (parsed.preRelease) {
    // A pre-release build wrote version 2, which no CLI reads: put credentials.json back to version 1 right away.
    try {
      await writeCredentials(parsed.credentials);
    } catch {
      // read-only config directory: the next write converts it
    }
  }
  return parsed.credentials;
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
  const credentials = await readCredentials();
  return Object.entries(credentials.profiles).map(([name, profile]) => ({
    name,
    active: name === credentials.activeProfile,
    profile,
  }));
}

export async function getProfile(name: string): Promise<Profile | undefined> {
  return (await readCredentials()).profiles[name];
}

/** The machine's default profile: what a command uses when nothing names another one. */
export async function activeProfileName(): Promise<string | undefined> {
  return (await readCredentials()).activeProfile;
}

/** `profile use`: make `name` the default profile. False when there is no such profile. */
export async function useProfile(name: string): Promise<boolean> {
  const credentials = await readCredentials();
  if (!credentials.profiles[name]) return false;
  credentials.activeProfile = name;
  credentials.holders[credentials.profiles[name].apiUrl] = name;
  await writeCredentials(credentials);
  return true;
}

/** The name of the profile a command would use for this endpoint, if one is stored. */
export async function savedProfileName(apiUrl: string): Promise<string | undefined> {
  return findProfile(await readCredentials(), apiUrl)?.name;
}

export async function savedToken(apiUrl: string): Promise<string | undefined> {
  return findProfile(await readCredentials(), apiUrl)?.profile.token;
}

export async function savedProfile(apiUrl: string): Promise<Profile | undefined> {
  return findProfile(await readCredentials(), apiUrl)?.profile;
}

/** The endpoint of the machine's default profile. */
export async function activeApiUrl(): Promise<string | undefined> {
  const credentials = await readCredentials();
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
  const credentials = await readCredentials();
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
      await writeCredentials(credentials);
      return { removed: true, activeApiUrl: activeUrl(), remaining: left };
    }
  }
  delete credentials.profiles[name];
  if (credentials.activeProfile === name) credentials.activeProfile = undefined;
  await writeCredentials(credentials);
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
  const credentials = await readCredentials();
  const name = writeTarget(credentials, apiUrl);
  credentials.profiles[name] = { apiUrl, token, kind: kind ?? credentials.profiles[name]?.kind, teams: {} };
  credentials.holders[apiUrl] = name;
  activateIfNone(credentials, name);
  await writeCredentials(credentials);
  return saved(credentials, name);
}

/** Store one team's key for a Cloud profile. The newest login becomes that profile's default team. */
export async function saveTeam(apiUrl: string, slug: string, team: StoredTeam): Promise<SaveResult> {
  const credentials = await readCredentials();
  const name = writeTarget(credentials, apiUrl);
  const teams = { ...credentials.profiles[name]?.teams, [slug]: team };
  credentials.profiles[name] = { apiUrl, token: team.token, kind: "cloud", team: slug, teams };
  credentials.holders[apiUrl] = name;
  activateIfNone(credentials, name);
  await writeCredentials(credentials);
  return saved(credentials, name);
}

/** Decide which profile `credentials.json` holds for each endpoint: the one most recently saved or switched to there. */
function settleHolders(credentials: Credentials): void {
  const holders: Record<string, string> = {};
  for (const [name, profile] of Object.entries(credentials.profiles)) {
    const current = credentials.holders[profile.apiUrl];
    if (holders[profile.apiUrl] === undefined || current === name) holders[profile.apiUrl] = name;
  }
  credentials.holders = holders;
}

function credentialOf({ token, kind, team, teams }: Profile): Credential {
  return { token, kind, team, teams };
}

async function writeAtomic(directory: string, path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Atomic 0600 write of both files. `credentials.json` stays version 1 (see `Credentials`) and is written first, since
 * it is the one older CLIs depend on.
 */
async function writeCredentials(credentials: Credentials): Promise<void> {
  const directory = configDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  settleHolders(credentials);
  const endpoints: Record<string, Credential> = {};
  const profiles: Record<string, JsonObject> = {};
  for (const [name, profile] of Object.entries(credentials.profiles)) {
    const held = credentials.holders[profile.apiUrl] === name;
    if (held) endpoints[profile.apiUrl] = credentialOf(profile);
    profiles[name] = held
      ? { endpoint: profile.apiUrl }
      : { endpoint: profile.apiUrl, credential: credentialOf(profile) };
  }
  const active = credentials.activeProfile === undefined ? undefined : credentials.profiles[credentials.activeProfile];
  const v1 = { version: 1, activeApiUrl: active?.apiUrl, profiles: endpoints };
  await writeAtomic(directory, credentialsPath(), `${JSON.stringify(v1, null, 2)}\n`);
  const file = { version: 1, activeProfile: credentials.activeProfile, profiles };
  await writeAtomic(directory, profilesPath(), `${JSON.stringify(file, null, 2)}\n`);
}

/** $HOME when set (as Wrangler's xdg-app-paths does), else the account's home directory. */
function home(): string {
  return process.env.HOME || homedir();
}
