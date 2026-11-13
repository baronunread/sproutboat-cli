/**
 * `sproutboat domains` on the Sproutboat Cloud. The Cloud has no domains resource: an app's routes are the `hosts` of its
 * spec. `list` reads them. Adding or removing a custom domain is an operator step for now (it needs a DNS record and a
 * route on the Cloud's edge as well as the entry in the spec), so the other verbs say so instead of calling a route the
 * Cloud does not have.
 */
import { CloudError } from "./cloud";
import { makeCall, type CloudCredentials } from "./cloud-deploy";
import { isSafeInteger, isString, jsonObject } from "./json";

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

/** The sentence for `add`, `verify` and `delete` against a Cloud. */
export function cloudDomainsUnsupported(sub: string, host: string): string {
  const verb = sub === "delete" ? "removed" : "added";
  return [
    `custom domains on the Cloud are ${verb} by a Sproutboat operator for now, so \`domains ${sub}\` changes nothing here.`,
    `Ask for ${host} to be routed to this app; \`sproutboat domains list\` shows what is routed, and \`sproutboat deploy\``,
    "keeps every route it did not add itself, so a domain an operator routed stays through later deploys.",
  ].join("\n");
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
