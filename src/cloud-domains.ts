/**
 * `sproutboat domains` on the Sproutboat Cloud. A team claims a hostname (`domains add`), publishes the TXT record the Cloud
 * hands back, and `domains verify` has the Cloud look it up through two public resolvers. Once verified, the team may route
 * the name (`routes` of a deploy, or Settings, Domains in the dashboard) and its certificate is ordered at the first visit.
 * `list` shows the app's routes and the team's claims; `delete` releases a claim (refused while an app still routes it).
 * Wrangler has no such verb (Cloudflare owns the zone); the flow follows the Cloud's own routes, `/v1/domains`.
 */
import { CloudError } from "./cloud";
import { makeCall, type CloudCredentials } from "./cloud-deploy";
import { isSafeInteger, isString, jsonObject, type JsonObject, type JsonValue } from "./json";

/** Names under this zone belong to the platform: `<project>.<team>.sproutboat.app` is every app's own route. */
export const PLATFORM_ZONE = ".sproutboat.app";

export type CloudRoute = { route: string; custom: boolean };
export type CloudRoutes = { routes: CloudRoute[]; applied: boolean | undefined; generation: number | undefined };

/** The routes of a deployed app, in the order the spec holds them, each marked custom when it is not under sproutboat.app. */
export async function listCloudRoutes(credentials: CloudCredentials, project: string): Promise<CloudRoutes> {
  const result = await makeCall(credentials)({ method: "GET", path: `/v1/apps/${project}`, ok: [404] });
  if (result.status === 404)
    throw new CloudError(`${project} is not deployed yet, so it has no routes: run \`sproutboat deploy\` first`);
  const hosts = jsonObject(result.body?.spec ?? null)?.hosts;
  const routes = (Array.isArray(hosts) ? hosts.filter(isString) : []).map((route) => ({
    route,
    custom: !route.split("/")[0]!.endsWith(PLATFORM_ZONE),
  }));
  const apply = jsonObject(result.body?.apply ?? null);
  const generation = result.body?.record_generation;
  return {
    routes,
    applied: apply ? apply.state === "applied" : undefined,
    generation: isSafeInteger(generation) ? generation : undefined,
  };
}

export type DomainClaim = {
  host: string;
  state: "pending" | "verified" | "lost";
  method: string;
  record: { type: string; name: string; value: string } | null;
  routes: string[];
  lostReason: string | null;
};

function parseClaim(value: JsonValue | undefined): DomainClaim | undefined {
  const o = jsonObject(value ?? null);
  if (!o || !isString(o.host) || (o.state !== "pending" && o.state !== "verified" && o.state !== "lost"))
    return undefined;
  const t = jsonObject(o.txt ?? null);
  return {
    host: o.host,
    state: o.state,
    method: isString(o.method) ? o.method : "txt",
    record:
      t && isString(t.type) && isString(t.name) && isString(t.value)
        ? { type: t.type, name: t.name, value: t.value }
        : null,
    routes: (Array.isArray(o.routes) ? o.routes : []).flatMap((r) => {
      const k = jsonObject(r ?? null)?.key;
      return isString(k) ? [k] : [];
    }),
    lostReason: isString(o.lost_reason) ? o.lost_reason : null,
  };
}

/** The team's claims. An older Cloud (no /v1/domains) or a key without domain:read answers nothing: that is "no claims", not an error. */
export async function listCloudClaims(credentials: CloudCredentials): Promise<DomainClaim[]> {
  const result = await makeCall(credentials)({ method: "GET", path: "/v1/domains", ok: [403, 404] });
  if (result.status !== 200) return [];
  const list = result.body?.domains;
  return (Array.isArray(list) ? list : []).flatMap((entry) => {
    const claim = parseClaim(entry);
    return claim ? [claim] : [];
  });
}

/** The lines that tell the owner what to publish. */
export function describeRecord(claim: DomainClaim): string[] {
  if (!claim.record) return [];
  return [
    "Publish this DNS record at your DNS provider (it proves the name is yours; you can delete it once verified):",
    `  ${claim.record.type}  ${claim.record.name}  "${claim.record.value}"`,
    `then run: sproutboat domains verify ${claim.host}`,
  ];
}

const WHAT = { pending: "waiting for the TXT record", verified: "verified", lost: "no longer yours" } as const;

/** `domains list`'s second part, for the claims; empty when the team has none. */
export function describeClaims(claims: DomainClaim[]): string[] {
  if (claims.length === 0) return [];
  const width = Math.max(...claims.map((c) => c.host.length));
  const lines = ["", "domains of this team:"];
  for (const c of claims) {
    const used = c.routes.length ? `  used by routes: ${c.routes.join(", ")}` : "";
    lines.push(
      `  ${c.host.padEnd(width)}  ${WHAT[c.state]}${c.method === "operator" && c.state === "verified" ? " (added by Sproutboat)" : ""}${used}`,
    );
    if (c.state === "lost" && c.lostReason) lines.push(`    ${c.lostReason}`);
  }
  return lines;
}

/** Claim a hostname. Idempotent: adding it again prints the same record. */
export async function addCloudDomain(credentials: CloudCredentials, host: string): Promise<string[]> {
  const result = await makeCall(credentials)({ method: "POST", path: "/v1/domains", json: { host }, ok: [400, 429] });
  if (result.status === 400 || result.status === 429) throw new CloudError(errorLine(result.body, result.status));
  const claim = parseClaim(result.body ?? undefined);
  if (!claim) throw new CloudError("the Cloud answered with something that is not a domain claim");
  if (claim.state === "verified") return [`${claim.host} is already verified for this team`];
  return [
    `${result.status === 201 ? "Added" : "Already added:"} ${claim.host} (${WHAT[claim.state]})`,
    ...describeRecord(claim),
  ];
}

/** Ask the Cloud to look the record up. A record that is not there yet is an error (exit 1) that says what to publish. */
export async function verifyCloudDomain(credentials: CloudCredentials, host: string): Promise<string[]> {
  const result = await makeCall(credentials)({
    method: "POST",
    path: `/v1/domains/${encodeURIComponent(host)}/verify`,
    ok: [400, 404, 409, 429],
  });
  if (result.status === 404)
    throw new CloudError(`${host} is not added yet: run \`sproutboat domains add ${host}\` first`);
  if (result.status === 400 || result.status === 409 || result.status === 429) {
    const expected = jsonObject(result.body?.expected ?? null);
    const record =
      expected && isString(expected.type) && isString(expected.name) && isString(expected.value)
        ? `\nExpected: ${expected.type}  ${expected.name}  "${expected.value}"\nDNS can take a few minutes to spread; run the command again shortly.`
        : "";
    throw new CloudError(errorLine(result.body, result.status) + record);
  }
  const claim = parseClaim(result.body ?? undefined);
  if (!claim) throw new CloudError("the Cloud answered with something that is not a domain claim");
  return [
    `${claim.host} is verified for this team.`,
    "Route it from your project (a route on the name in the deploy, or Settings, Domains in the dashboard); its certificate is ordered at the first visit.",
  ];
}

/** Release a claim. */
export async function deleteCloudDomain(credentials: CloudCredentials, host: string): Promise<string[]> {
  const result = await makeCall(credentials)({
    method: "DELETE",
    path: `/v1/domains/${encodeURIComponent(host)}`,
    ok: [404, 409],
  });
  if (result.status === 404) throw new CloudError(`${host} is not one of this team's domains`);
  if (result.status === 409) throw new CloudError(errorLine(result.body, result.status));
  return [`removed ${host}`];
}

function errorLine(body: JsonObject | undefined, status: number): string {
  const text = isString(body?.error) ? body.error : isString(body?.message) ? body.message : `HTTP ${status}`;
  return text[0]!.toUpperCase() === text[0] ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** The lines `domains list` prints for a Cloud app. */
export function describeCloudRoutes(project: string, listed: CloudRoutes): string[] {
  if (listed.routes.length === 0) return [`${project} has no routes yet`];
  const width = Math.max(...listed.routes.map((entry) => entry.route.length));
  const lines = listed.routes.map((entry) =>
    `${(entry.custom ? "custom" : "built-in").padEnd(9)} ${entry.route.padEnd(width)}`.trimEnd(),
  );
  if (listed.applied === false) lines.push("(the newest record is not applied on a host yet)");
  return lines;
}
