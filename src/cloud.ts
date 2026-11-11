/**
 * Sproutboat Cloud sessions: endpoint detection, the device-code login (RFC 8628), whoami, logout, and which
 * team a command acts for. Nothing here exits the process or reads the terminal directly, so tests drive it
 * against a fake server with an injected `CloudIo`.
 */
import { isSafeInteger, isString, jsonObject, parseJsonValue, type JsonObject } from "./json";
import {
  forgetToken,
  saveTeam,
  savedProfile,
  type EndpointKind,
  type Profile,
  type SaveResult,
  type StoredTeam,
} from "./credentials";

export const DEFAULT_API_URL = "https://dash.sproutboat.com";
export const CLI_CLIENT_ID = "sproutboat-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** A failure with a message fit to print as is. */
export class CloudError extends Error {}

export type CloudIo = {
  log(line: string): void;
  warn(line: string): void;
  /** stdin and stdout are terminals: a person is here to answer a prompt. */
  interactive: boolean;
  /** Open a URL in a browser. False when this machine cannot (headless, SSH, no opener). */
  openUrl(url: string): boolean;
  sleep(ms: number): Promise<void>;
  /** Pick one of `choices`; only called when `interactive`. */
  choose(question: string, choices: string[]): Promise<string>;
};

export function parseBody(text: string): JsonObject | undefined {
  try {
    return jsonObject(parseJsonValue(text));
  } catch {
    return undefined;
  }
}

/** The API's `{error}` text for a failed response, or a short fallback. */
function errorText(body: JsonObject | undefined, status: number): string {
  const message = body?.error_description ?? body?.error;
  return isString(message) ? message : `HTTP ${status}`;
}

async function fetchOrExplain(apiUrl: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new CloudError(`cannot reach ${apiUrl}; check the address and your network`);
  }
}

/**
 * Cloud or Community? The Cloud answers GET /v1/config; the Community control plane has no such route.
 * Throws when the endpoint cannot be reached at all.
 */
export async function detectKind(apiUrl: string): Promise<EndpointKind> {
  const response = await fetchOrExplain(apiUrl, `${apiUrl}/v1/config`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return "community";
  const body = parseBody(await response.text());
  return body !== undefined && "ingress" in body ? "cloud" : "community";
}

export type DeviceLoginResult = { token: string; keyId: string; keyName: string; slug: string; team: StoredTeam };

export type DeviceLoginOptions = {
  apiUrl: string;
  io: CloudIo;
  hostname: string;
  os: string;
  /** Asks the approval page to preselect this team. */
  account?: string;
  now?: () => number;
};

/** The RFC 8628 flow: ask for a code, show it, poll until the person approves in a browser. */
export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const { apiUrl, io } = options;
  const now = options.now ?? Date.now;
  const started = await fetchOrExplain(apiUrl, `${apiUrl}/v1/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLI_CLIENT_ID, hostname: options.hostname, os: options.os }),
  });
  const startedBody = parseBody(await started.text());
  if (started.status === 429) throw new CloudError("too many login attempts from this network; wait a few minutes");
  const deviceCode = startedBody?.device_code;
  const userCode = startedBody?.user_code;
  const verification = startedBody?.verification_uri_complete ?? startedBody?.verification_uri;
  if (!started.ok || !isString(deviceCode) || !isString(userCode) || !isString(verification))
    throw new CloudError(`could not start the login: ${errorText(startedBody, started.status)}`);
  const expiresIn = isSafeInteger(startedBody?.expires_in) ? startedBody.expires_in : 600;
  let interval = isSafeInteger(startedBody?.interval) && startedBody.interval > 0 ? startedBody.interval : 5;

  const url = new URL(verification);
  if (options.account) url.searchParams.set("team", options.account);
  const link = url.toString();
  const opened = io.interactive && io.openUrl(link);
  io.log(
    opened
      ? "Opening your browser to approve this login."
      : "Open this address in a browser, on any device where you are signed in:",
  );
  io.log(`  ${link}`);
  io.log(`Your code is ${userCode} (it expires in ${Math.round(expiresIn / 60)} minutes). Waiting for approval...`);

  const deadline = now() + expiresIn * 1000;
  let transient = 0;
  while (now() < deadline) {
    await io.sleep(interval * 1000);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/v1/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLI_CLIENT_ID }),
      });
    } catch {
      if (++transient > 5) throw new CloudError(`lost contact with ${apiUrl} while waiting for approval`);
      continue;
    }
    transient = 0;
    const body = parseBody(await response.text());
    if (response.ok) return deviceResult(body);
    const code = body?.error;
    if (response.status === 429 || code === "slow_down") {
      interval += 5;
      continue;
    }
    if (code === "authorization_pending") continue;
    if (code === "access_denied") throw new CloudError("the login was denied in the browser");
    if (code === "expired_token")
      throw new CloudError("the code expired before it was approved; run sproutboat login again");
    throw new CloudError(`login failed: ${errorText(body, response.status)}`);
  }
  throw new CloudError("the code expired before it was approved; run sproutboat login again");
}

function deviceResult(body: JsonObject | undefined): DeviceLoginResult {
  const organization = jsonObject(body?.organization ?? null);
  const token = body?.access_token;
  const slug = organization?.slug;
  if (!isString(token) || !isString(slug)) throw new CloudError("the login reply did not carry a key and a team");
  const team: StoredTeam = {
    token,
    id: isString(organization?.id) ? organization.id : "",
    name: isString(organization?.name) ? organization.name : slug,
    role: isString(body?.role) ? body.role : "",
    keyId: isString(body?.key_id) ? body.key_id : "",
    keyName: isString(body?.key_name) ? body.key_name : "",
  };
  return { token, keyId: team.keyId, keyName: team.keyName, slug, team };
}

export type Whoami = {
  organizationId: string;
  slug: string;
  name: string;
  keyId: string;
  keyName: string;
  permissions: string;
  person?: { name: string; email: string };
};

export function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** What a failed API response means to the person at the terminal. */
export function explainApiFailure(status: number, text: string, fromEnv: boolean): string {
  const body = parseBody(text);
  const detail = errorText(body, status);
  if (status === 403 && body?.error === "module-upload-disabled")
    return "modules are built by the Cloud; run `sproutboat deploy` without --module";
  if (status === 401)
    return fromEnv
      ? "SPROUTBOAT_API_TOKEN was rejected (invalid, expired or revoked); create a new key in Settings, API keys"
      : "this machine is not logged in, or its key was revoked; run `sproutboat login`";
  if (status === 403) {
    const need = isString(body?.need) ? ` (needs ${body.need})` : "";
    return `${detail}${need}: this key's role cannot do that; ask a team Owner or Admin, or use another team with --account`;
  }
  if (status === 413) return `${detail}: too large for the Cloud`;
  if (status === 429 && body?.reason === "rate") {
    const seconds = isSafeInteger(body.retry_after) ? ` in ${body.retry_after} s` : " shortly";
    return `too many requests for this team; try again${seconds}`;
  }
  if (status === 503 && body?.reason === "audit-unavailable")
    return "the Cloud could not record this request in its audit log, so it was not served; try again shortly";
  return `${detail} (HTTP ${status})`;
}

/** Ask the Cloud who a key belongs to. */
export async function fetchWhoami(apiUrl: string, token: string, fromEnv: boolean): Promise<Whoami> {
  const response = await fetchOrExplain(apiUrl, `${apiUrl}/v1/whoami`, { headers: authHeaders(token) });
  const text = await response.text();
  if (!response.ok) throw new CloudError(explainApiFailure(response.status, text, fromEnv));
  const body = parseBody(text);
  const key = jsonObject(body?.key ?? null);
  const slug = body?.organization_slug;
  if (!isString(slug)) throw new CloudError("this key does not belong to a team (is it an account API key, sbk_...?)");
  const created = jsonObject(body?.created_by ?? null);
  const permissions = jsonObject(key?.permissions ?? null);
  return {
    organizationId: isString(body?.organization) ? body.organization : "",
    slug,
    name: isString(body?.organization_name) ? body.organization_name : slug,
    keyId: isString(key?.id) ? key.id : "",
    keyName: isString(key?.name) ? key.name : "",
    permissions: permissions
      ? Object.entries(permissions)
          .map(([resource, actions]) => `${resource}:${Array.isArray(actions) ? actions.join("/") : ""}`)
          .join(" ")
      : "",
    person: isString(created?.email)
      ? { name: isString(created.name) ? created.name : "", email: created.email }
      : undefined,
  };
}

/** Delete the key on the server. `unreachable` and `already-gone` still allow removing the local copy. */
export async function revokeKey(apiUrl: string, token: string): Promise<"revoked" | "already-gone" | "unreachable"> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/keys/self`, { method: "DELETE", headers: authHeaders(token) });
  } catch {
    return "unreachable";
  }
  await response.text();
  if (response.ok) return "revoked";
  if (response.status === 401) return "already-gone";
  throw new CloudError(`the Cloud refused to revoke the key (HTTP ${response.status}); the local login was kept`);
}

export type TokenSource = "SPROUTBOAT_API_TOKEN" | "SPROUTBOAT_TOKEN" | "stored login";

/** The environment key, if any. SPROUTBOAT_API_TOKEN wins; SPROUTBOAT_TOKEN is the older name. */
export function envToken(
  env: Record<string, string | undefined> = process.env,
): { token: string; source: TokenSource } | undefined {
  if (env.SPROUTBOAT_API_TOKEN) return { token: env.SPROUTBOAT_API_TOKEN, source: "SPROUTBOAT_API_TOKEN" };
  if (env.SPROUTBOAT_TOKEN) return { token: env.SPROUTBOAT_TOKEN, source: "SPROUTBOAT_TOKEN" };
  return undefined;
}

export type CloudSession = { apiUrl: string; token: string; source: TokenSource; slug: string; name: string };

export type SessionOptions = {
  apiUrl: string;
  io: CloudIo;
  /** `--account`, then the `account` field of sproutboat.jsonc, already merged by the caller. */
  account?: string;
  env?: Record<string, string | undefined>;
  /** When logged out in a terminal: run the login (and store it), then continue. */
  login: (account?: string) => Promise<StoredLogin>;
};

export type StoredLogin = { slug: string; team: StoredTeam };

/**
 * The credential and team a Cloud command acts for. The environment key always wins (CI); its team is the key's
 * own. Otherwise the stored teams: the requested one, the only one, or a choice when there are several.
 */
export async function resolveSession(options: SessionOptions): Promise<CloudSession> {
  const { apiUrl, io } = options;
  const env = options.env ?? process.env;
  const requested = options.account ?? (env.SPROUTBOAT_ACCOUNT || undefined);
  const fromEnv = envToken(env);
  if (fromEnv) {
    const who = await fetchWhoami(apiUrl, fromEnv.token, true);
    if (requested && requested !== who.slug)
      throw new CloudError(
        `${fromEnv.source} belongs to the team "${who.slug}", but the account is "${requested}"; use a key from that team`,
      );
    return { apiUrl, token: fromEnv.token, source: fromEnv.source, slug: who.slug, name: who.name };
  }

  const profile = await savedProfile(apiUrl);
  if (!profile) {
    if (!io.interactive)
      throw new CloudError(
        `not logged in to ${apiUrl}. Run \`sproutboat login\`, or set SPROUTBOAT_API_TOKEN to an account API key (for CI)`,
      );
    io.log(`Not logged in to ${apiUrl}; starting the login.`);
    const done = await options.login(requested);
    return { apiUrl, token: done.team.token, source: "stored login", slug: done.slug, name: done.team.name };
  }

  const stored = await teamsOf(apiUrl, profile);
  const slugs = Object.keys(stored);
  let slug: string;
  if (requested) {
    if (!stored[requested])
      throw new CloudError(
        `not logged in to the team "${requested}" on ${apiUrl}; run \`sproutboat login --account ${requested}\``,
      );
    slug = requested;
  } else if (slugs.length === 1) slug = slugs[0]!;
  else if (io.interactive) slug = await io.choose("Which team should this deploy go to?", slugs);
  else
    throw new CloudError(
      `you are logged in to ${slugs.length} teams (${slugs.join(", ")}); choose one with \`account\` in sproutboat.jsonc, --account or SPROUTBOAT_ACCOUNT`,
    );
  const team = stored[slug]!;
  return { apiUrl, token: team.token, source: "stored login", slug, name: team.name || slug };
}

/** A profile written by `login --token` before the team was known has no teams: ask the Cloud which one it is. */
async function teamsOf(apiUrl: string, profile: Profile): Promise<Record<string, StoredTeam>> {
  if (Object.keys(profile.teams).length > 0) return profile.teams;
  const who = await fetchWhoami(apiUrl, profile.token, false);
  return {
    [who.slug]: {
      token: profile.token,
      id: who.organizationId,
      name: who.name,
      role: "",
      keyId: who.keyId,
      keyName: who.keyName,
    },
  };
}

/** Run the device flow and keep the key. */
export async function loginAndStore(
  options: DeviceLoginOptions,
): Promise<StoredLogin & SaveResult & { keyName: string }> {
  const result = await deviceLogin(options);
  const saved = await saveTeam(options.apiUrl, result.slug, result.team);
  if (options.account && options.account !== result.slug)
    options.io.warn(`You approved the team "${result.slug}", not "${options.account}".`);
  return { slug: result.slug, team: result.team, ...saved, keyName: result.keyName };
}

/** Store a key the person already holds (`login --token`), after asking the Cloud whose it is. */
export async function storeGivenKey(apiUrl: string, token: string): Promise<StoredLogin> {
  const who = await fetchWhoami(apiUrl, token, false);
  const team: StoredTeam = {
    token,
    id: who.organizationId,
    name: who.name,
    role: "",
    keyId: who.keyId,
    keyName: who.keyName,
  };
  await saveTeam(apiUrl, who.slug, team);
  return { slug: who.slug, team };
}

export type LogoutOutcome =
  | { kind: "none" }
  | { kind: "done"; slug: string; server: "revoked" | "already-gone" | "unreachable"; remaining: string[] };

/** Revoke the key server side when possible, then forget it here. Without `account`, the default team. */
export async function cloudLogout(apiUrl: string, account?: string): Promise<LogoutOutcome> {
  const profile = await savedProfile(apiUrl);
  if (!profile) return { kind: "none" };
  const slug = account ?? profile.team ?? Object.keys(profile.teams)[0];
  const team = slug === undefined ? undefined : profile.teams[slug];
  if (slug === undefined || !team) {
    if (account !== undefined || Object.keys(profile.teams).length > 0) return { kind: "none" };
    // A key stored without a team: revoke it and drop the endpoint.
    const server = await revokeKey(apiUrl, profile.token);
    await forgetToken(apiUrl);
    return { kind: "done", slug: "(unknown team)", server, remaining: [] };
  }
  const server = await revokeKey(apiUrl, team.token);
  const result = await forgetToken(apiUrl, slug);
  return { kind: "done", slug, server, remaining: result.remaining };
}
