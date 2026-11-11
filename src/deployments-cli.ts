/**
 * `sproutboat deployments list | status | tail <id>`. On the Cloud a deployment is a build (the deploy-from-source flow):
 * `GET /v1/apps/<app>/builds` lists them, `GET /v1/apps/<app>` says what is live, and `tail` follows one build's event
 * stream server-side, which is what a deploy that was detached with Ctrl-C needs. On self-hosted Community a deployment is a
 * version of the project (`/api/projects/<app>/deployments`), and there is nothing to follow: a deploy there is finished
 * when the command returns.
 */
import { makeCall, parseBuildView, type BuildView, type CloudCredentials } from "./cloud-deploy";
import { isSafeInteger, isString, jsonObject, type JsonObject } from "./json";
import { bold, dim, ok, rose } from "./style";

export type DeploymentsFlags = { json: boolean; limit: number; account?: string };
export const LIST_LIMIT = 10;
export const LIST_USAGE = "deployments list [--json]";
export const STATUS_USAGE = "deployments status [--json]";
export const TAIL_USAGE = "deployments tail <id>";

export class DeploymentsUsageError extends Error {
  constructor(
    message: string,
    readonly usage: string,
  ) {
    super(message);
  }
}

/** Positionals and flags after `deployments <sub>`. */
export function parseDeploymentsArgs(args: readonly string[], usage: string) {
  const flags: DeploymentsFlags = { json: false, limit: LIST_LIMIT };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (name === "--json") {
      if (equals > 0) throw new DeploymentsUsageError("--json takes no value", usage);
      flags.json = true;
    } else if (name === "--account") {
      const value = equals > 0 ? arg.slice(equals + 1) : args[(index += 1)];
      if (!value || (equals < 0 && value.startsWith("--")))
        throw new DeploymentsUsageError(`${name} needs a value`, usage);
      flags.account = value;
    } else if (arg.startsWith("-")) throw new DeploymentsUsageError(`unknown option ${arg}`, usage);
    else positional.push(arg);
  }
  return { positional, flags };
}

export type Live = {
  recordGeneration: number | null;
  appliedGeneration: number | null;
  state: string | null;
  error: string | null;
  hosts: string[];
};

/** What the Cloud runs for an app now: the record generation, whether a host applied it, and its hostnames. */
export function parseLive(body: JsonObject | undefined): Live {
  const apply = jsonObject(body?.apply ?? null);
  const spec = jsonObject(body?.spec ?? null);
  const hosts = Array.isArray(spec?.hosts) ? spec.hosts.filter(isString) : [];
  return {
    recordGeneration: isSafeInteger(body?.record_generation) ? body.record_generation : null,
    appliedGeneration: isSafeInteger(apply?.applied_generation) ? apply.applied_generation : null,
    state: isString(apply?.state) ? apply.state : null,
    error: isString(apply?.error) ? apply.error : null,
    hosts,
  };
}

export type CloudDeployment = {
  id: string;
  state: string;
  generation: number | null;
  cached: boolean;
  createdAt: string | null;
  finishedAt: string | null;
  hosts: string[];
  wallMs: number | null;
  error: string | null;
  /** The build whose record generation the host has applied. */
  live: boolean;
};

export function parseDeployments(body: JsonObject | undefined, live: Live | null): CloudDeployment[] {
  const list = Array.isArray(body?.builds) ? body.builds : [];
  return list.flatMap((entry) => {
    const item = jsonObject(entry);
    if (!item || !isString(item.id) || !isString(item.state)) return [];
    const view = parseBuildView(item);
    const stats = jsonObject(item.stats ?? null);
    const generation = view.recordGeneration ?? null;
    return [
      {
        id: view.id,
        state: view.state,
        generation,
        cached: view.cached,
        createdAt: isString(item.queued_at) ? item.queued_at : null,
        finishedAt: isString(item.finished_at) ? item.finished_at : null,
        hosts: Array.isArray(item.hosts) ? item.hosts.filter(isString) : [],
        wallMs: isSafeInteger(stats?.wall_ms) ? stats.wall_ms : null,
        error: view.error?.message ?? null,
        live:
          view.state === "ready" &&
          generation !== null &&
          live?.appliedGeneration === generation &&
          live.state === "applied",
      },
    ];
  });
}

export async function fetchLive(credentials: CloudCredentials, project: string): Promise<Live | null> {
  const reply = await makeCall(credentials)({ method: "GET", path: `/v1/apps/${project}`, ok: [404] });
  return reply.status === 404 ? null : parseLive(reply.body);
}

export async function fetchDeployments(credentials: CloudCredentials, project: string, limit = LIST_LIMIT) {
  const live = await fetchLive(credentials, project);
  const reply = await makeCall(credentials)({ method: "GET", path: `/v1/apps/${project}/builds?limit=${limit}` });
  return { live, deployments: parseDeployments(reply.body, live) };
}

const when = (iso: string | null) => iso ?? "unknown";

export function formatDeployment(item: CloudDeployment): string {
  const lines = [
    `${bold("Deployment:")}  ${item.id}${item.live ? `  ${ok("live")}` : ""}`,
    `Created:     ${when(item.createdAt)}`,
    `State:       ${item.state}${item.wallMs !== null && !item.cached ? ` (built in ${(item.wallMs / 1000).toFixed(1)} s)` : ""}${item.cached ? " (cached build)" : ""}`,
  ];
  if (item.generation !== null) lines.push(`Generation:  ${item.generation}`);
  if (item.hosts.length > 0) lines.push(`Hosts:       ${item.hosts.join(", ")}`);
  if (item.error) lines.push(`Error:       ${rose(item.error.split("\n")[0]!)}`);
  return lines.join("\n");
}

export function formatStatus(project: string, live: Live | null, latest: CloudDeployment | undefined): string {
  if (!live) return `${project} is not deployed yet: run \`sproutboat deploy\` first`;
  const applied = live.state === "applied" && live.appliedGeneration === live.recordGeneration;
  const lines = [
    `${bold("Application:")}  ${project}`,
    `Generation:   ${live.recordGeneration ?? "unknown"}${applied ? ` ${ok("applied by a host")}` : ""}`,
  ];
  if (!applied)
    lines.push(`Host apply:   ${live.state ?? "waiting for a host"}${live.error ? ` (${live.error})` : ""}`);
  if (live.hosts.length > 0) lines.push(`Hosts:        ${live.hosts.join(", ")}`);
  if (latest) lines.push(`Latest build: ${latest.id}  ${latest.state}${latest.live ? "  (live)" : ""}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- self-hosted Community

export type CommunityVersion = { id: string; artifact: string; deployedAt: string; active: boolean };

/** `GET /api/projects/<app>/deployments`: an array of { id, artifact, deployedAt, active }. */
export function parseCommunityVersions(value: JsonObject[]): CommunityVersion[] {
  return value.flatMap((item) =>
    isString(item.id) && isString(item.artifact) && isString(item.deployedAt)
      ? [{ id: item.id, artifact: item.artifact, deployedAt: item.deployedAt, active: item.active === true }]
      : [],
  );
}

export function formatCommunityVersion(item: CommunityVersion): string {
  return [
    `${bold("Deployment:")}  ${item.id}${item.active ? `  ${ok("active")}` : ""}`,
    `Created:     ${item.deployedAt}`,
    `Artifact:    ${item.artifact.slice(0, 12)}`,
  ].join("\n");
}

export const COMMUNITY_TAIL =
  "deployments tail is not supported on self-hosted Community: a deploy there finishes before `sproutboat deploy` returns, so there is nothing to follow (see `sproutboat versions list` for past deploys)";

// ---------------------------------------------------------------- tail

export function tailSummary(view: BuildView): string {
  if (view.state === "ready")
    return `${ok("ready")}${view.recordGeneration !== undefined ? `; record generation ${view.recordGeneration}` : ""}`;
  if (view.state === "canceled") return `${dim("canceled")}${view.error ? `: ${view.error.message}` : ""}`;
  return `${rose("failed")}: ${view.error?.message.split("\n").at(-1) ?? "no reason given"}`;
}
