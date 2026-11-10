/**
 * `sproutboat deploy` against the Sproutboat Cloud: upload the compiled module by digest, the assets by hash,
 * write the app, and wait for a host to apply it. The same calls tools/sbcloud-deploy makes in the cloud repo.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAssetRules, walkAssets, type AssetManifest } from "./assets";
import type { SproutboatConfig } from "./config";
import { authHeaders, CloudError, explainApiFailure, parseBody, type CloudIo } from "./cloud";
import { isSafeInteger, isString, jsonObject, type JsonObject, type JsonValue } from "./json";
import { dim, ok } from "./style";

export const CLOUD_PROJECT_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

/** Compiler progress lines ("parsed", "generated IR", "[12.3ms] optimized") say how far it got, not why it stopped. */
const PROGRESS =
  /^(\[[^\]]*\]\s*)?(\S+\s+)?(parsed|generated IR|optimi[sz]ed|compiled|linked|assembled|lowered|wrote)\b[^a-z]*$/i;
const REASON = /error|fail|time(d)? ?out|exceed|reject|unsupported|cannot|can't|not allowed|killed|stopped/i;

/**
 * The one line the final "build failed:" shows: the most informative line of the Cloud's message. A reason beats progress
 * lines, the last reason beats the first (the compiler's own message comes after its warnings), and with no reason at all the
 * first line is shown. The full text stays in the build log above.
 */
export function buildFailureHeadline(message: string | undefined): string {
  const lines = (message ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "no reason given";
  const real = lines.filter((l) => !PROGRESS.test(l));
  const reasons = real.filter((l) => REASON.test(l));
  return (reasons.at(-1) ?? real.at(-1) ?? lines[0])!;
}

/** The printed address of an app. *.sproutboat.app names have no public DNS or certificate yet (docs/app-hostnames.md in the Cloud repo). */
export function hostNote(url: string): string | undefined {
  return /^https:\/\/[^/]+\.sproutboat\.app(\/|$)/.test(url)
    ? "not publicly routed yet: the name has no DNS record or certificate"
    : undefined;
}

export const hostFor = (project: string, team: string): string => `${project}.${team}.sproutboat.app`;

export type AssetBundle = {
  /** The manifest JSON as it is uploaded; its sha256 names it. */
  manifestText: string;
  manifestSha: string;
  /** Blob digest to the file that holds it. */
  blobs: Map<string, string>;
  files: number;
  bytes: number;
};

/** The same manifest `sproutboat build` writes as assets.json, read straight from the project's assets directory. */
export function buildAssetBundle(projectDir: string, assets: NonNullable<SproutboatConfig["assets"]>): AssetBundle {
  const dir = resolve(projectDir, assets.directory);
  if (!existsSync(dir))
    throw new CloudError(`assets.directory "${assets.directory}" not found; run your site build first`);
  const manifest: AssetManifest = {
    notFound: assets.not_found_handling ?? "none",
    runSproutFirst: assets.run_sprout_first ?? false,
    files: walkAssets(dir),
  };
  const rules = readAssetRules(dir);
  if (rules.headers.length) manifest.headers = rules.headers;
  if (rules.redirects.length) manifest.redirects = rules.redirects;
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const blobs = new Map<string, string>();
  let bytes = 0;
  for (const [key, entry] of Object.entries(manifest.files)) {
    blobs.set(entry.hash, resolve(dir, `.${key}`));
    bytes += entry.size;
  }
  return {
    manifestText,
    manifestSha: createHash("sha256").update(manifestText).digest("hex"),
    blobs,
    files: Object.keys(manifest.files).length,
    bytes,
  };
}

/** The platform runtime gates service bindings between Cloud apps behind this compatibility date. */
export const SERVICE_BINDINGS_MIN_DATE = "2026-11-18";

export type ServiceRef = { binding: string; service: string };
type ServiceBindingEntry = { name: string; kind: "service"; resource_id: null; config: Record<string, never> };
/** What the app spec carries for service bindings: the binding entries and the callee app id per binding. */
export type ServiceWiring = { bindings: ServiceBindingEntry[]; services: Record<string, string> };

/** What a deploy adds to the app spec beyond module, hosts and assets. */
export type SpecExtras = {
  /** Service bindings from sproutboat.jsonc (`services`), resolved against the team's Cloud apps before anything is written. */
  services?: ServiceRef[];
  compatibilityDate?: string;
  /** Sent as `secrets_patch.set`: merged into the app's secrets in the same write. A deploy never replaces the set. */
  secrets?: Record<string, string>;
};

/** Refuse, before anything is uploaded, a service binding the Cloud would not run: too old a date, or the app itself. */
export function checkServiceBindings(project: string, services: ServiceRef[], compatibilityDate: string | undefined) {
  if (services.length === 0) return;
  for (const { binding, service } of services)
    if (service === project)
      throw new CloudError(
        `service binding ${binding} points at this app (${project}); an app cannot bind itself, bind a different app`,
      );
  if (compatibilityDate === undefined || compatibilityDate < SERVICE_BINDINGS_MIN_DATE)
    throw new CloudError(
      `service bindings between Cloud apps need compatibility_date ${SERVICE_BINDINGS_MIN_DATE} or later (sproutboat.jsonc has ${compatibilityDate ?? "none"}); set compatibility_date to ${SERVICE_BINDINGS_MIN_DATE} or later`,
    );
}

/** Match each `service` to the team's Cloud app of that project name (GET /v1/apps); a missing callee fails the deploy. */
export async function resolveServiceBindings(
  call: CallFn,
  project: string,
  services: ServiceRef[],
): Promise<ServiceWiring | undefined> {
  if (services.length === 0) return undefined;
  const listed = (await call({ method: "GET", path: "/v1/apps" })).body?.apps;
  const ids = new Map<string, string>();
  for (const entry of Array.isArray(listed) ? listed : []) {
    const app = jsonObject(entry);
    if (app && isString(app.project) && isString(app.app_id)) ids.set(app.project, app.app_id);
  }
  const wiring: ServiceWiring = { bindings: [], services: {} };
  for (const { binding, service } of services) {
    const id = ids.get(service);
    if (id === undefined)
      throw new CloudError(
        `service binding ${binding} needs the app "${service}", which is not deployed in this team: deploy it first (run \`sproutboat deploy\` in its directory), then deploy ${project} again`,
      );
    wiring.bindings.push({ name: binding, kind: "service", resource_id: null, config: {} });
    wiring.services[binding] = id;
  }
  return wiring;
}

function applyExtras(
  spec: AppSpec | BuildSpec,
  wiring: ServiceWiring | undefined,
  secrets: Record<string, string> | undefined,
) {
  if (wiring) {
    spec.bindings = wiring.bindings;
    spec.services = wiring.services;
  }
  if (secrets && Object.keys(secrets).length > 0) spec.secrets_patch = { set: secrets };
}

export type CloudDeployPlan = SpecExtras & {
  apiUrl: string;
  token: string;
  tokenFromEnv: boolean;
  project: string;
  hosts: string[];
  modulePath: string;
  assets?: AssetBundle;
  noWait: boolean;
  /** Milliseconds to wait for a host to apply the record. */
  waitMs?: number;
  pollMs?: number;
};

export type CloudDeployResult = {
  created: boolean;
  generation: number;
  url: string | undefined;
  applied: boolean | "skipped";
};

type SpecAdditions = {
  bindings?: ServiceBindingEntry[];
  services?: Record<string, string>;
  secrets_patch?: { set: Record<string, string> };
};
type AppSpec = { module: { sha256: string }; hosts: string[]; assets_manifest_ref?: string } & SpecAdditions;
type Call = { method: string; path: string; body?: BodyInit; json?: object; ok?: number[] };
type CallResult = { status: number; text: string; body?: JsonObject };
type CallFn = (c: Call) => Promise<CallResult>;
export type CloudCredentials = Pick<CloudDeployPlan, "apiUrl" | "token" | "tokenFromEnv">;

/** One authenticated call to the Cloud API; a non-2xx status that is not in `ok` becomes a CloudError. */
export function makeCall(plan: CloudCredentials): CallFn {
  return async (c) => {
    const headers = new Headers(authHeaders(plan.token));
    let body = c.body;
    if (c.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(c.json);
    } else if (body !== undefined) headers.set("content-type", "application/octet-stream");
    let response: Response;
    try {
      response = await fetch(`${plan.apiUrl}${c.path}`, { method: c.method, headers, body });
    } catch {
      throw new CloudError(`cannot reach ${plan.apiUrl}; check the address and your network`);
    }
    const text = await response.text();
    if (!response.ok && !(c.ok ?? []).includes(response.status))
      throw new CloudError(explainApiFailure(response.status, text, plan.tokenFromEnv));
    return { status: response.status, text, body: parseBody(text) };
  };
}

/** What the app holds now: tells a first deploy from an update, and keeps its assets when this deploy has none. */
async function resolveAssets(
  call: CallFn,
  plan: { project: string; assets?: AssetBundle },
  io: CloudIo,
): Promise<{ created: boolean; assetsRef: string | undefined }> {
  const current = await call({ method: "GET", path: `/v1/apps/${plan.project}`, ok: [404] });
  const created = current.status === 404;
  let assetsRef: string | undefined;
  if (plan.assets) {
    await pushAssets(call, plan.assets, io);
    assetsRef = `assets/${plan.assets.manifestSha}`;
  } else if (!created) {
    const spec = jsonObject(current.body?.spec ?? null);
    const ref = spec?.assets_manifest_ref;
    if (isString(ref)) {
      assetsRef = ref;
      io.log(`  assets  keeping the current ${ref.slice(0, 19)}`);
    }
  }
  return { created, assetsRef };
}

/** Wait for a host to apply `generation`; false at the deadline. */
async function waitForApply(
  call: CallFn,
  plan: { project: string; waitMs?: number; pollMs?: number },
  generation: number,
  io: CloudIo,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + (plan.waitMs ?? 120_000);
  io.log(`  record generation ${generation} written; waiting for a host to apply it`);
  for (;;) {
    if (signal?.aborted)
      throw new Interrupted(`interrupted; generation ${generation} is saved and applies when a host is available`);
    const state = await call({ method: "GET", path: `/v1/apps/${plan.project}` });
    const apply = jsonObject(state.body?.apply ?? null);
    const phase = apply?.state;
    if (phase === "failed" || phase === "fenced")
      throw new CloudError(
        `the host did not apply generation ${generation} (${phase}): ${isString(apply?.error) ? apply.error : "no reason given"}`,
      );
    const applied = apply?.applied_generation;
    if (phase === "applied" && isSafeInteger(applied) && applied >= generation) return true;
    if (Date.now() >= deadline) return false;
    await io.sleep(plan.pollMs ?? 2000);
  }
}

export async function deployToCloud(plan: CloudDeployPlan, io: CloudIo): Promise<CloudDeployResult> {
  const call = makeCall(plan);
  checkServiceBindings(plan.project, plan.services ?? [], plan.compatibilityDate);
  const wiring = await resolveServiceBindings(call, plan.project, plan.services ?? []);
  const { created, assetsRef } = await resolveAssets(call, plan, io);

  const bytes = new Uint8Array(readFileSync(plan.modulePath));
  const sha = createHash("sha256").update(bytes).digest("hex");
  io.log(`  module  ${sha.slice(0, 12)} (${(bytes.byteLength / 1024).toFixed(0)} KiB)`);
  await call({ method: "PUT", path: `/v1/modules/${sha}`, body: bytes });

  const spec: AppSpec = { module: { sha256: sha }, hosts: plan.hosts };
  if (assetsRef !== undefined) spec.assets_manifest_ref = assetsRef;
  applyExtras(spec, wiring, plan.secrets);
  const put = await call({ method: "PUT", path: `/v1/apps/${plan.project}`, json: spec });
  const generation = put.body?.record_generation;
  if (!isSafeInteger(generation)) throw new CloudError("the Cloud's reply carried no record generation");
  const url = plan.hosts[0] === undefined ? undefined : `https://${plan.hosts[0]}`;
  if (plan.noWait) return { created, generation, url, applied: "skipped" };

  const applied = await waitForApply(call, plan, generation, io);
  return { created, generation, url, applied };
}

async function pushAssets(call: CallFn, bundle: AssetBundle, io: CloudIo): Promise<void> {
  const hashes = [...bundle.blobs.keys()];
  const missingBody = (await call({ method: "POST", path: "/v1/assets/missing", json: { sha256: hashes } })).body
    ?.missing;
  const missing = Array.isArray(missingBody) ? missingBody.filter(isString) : [];
  const queue = [...missing];
  let uploaded = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let hash = queue.shift(); hash !== undefined; hash = queue.shift()) {
        const file = bundle.blobs.get(hash);
        if (file === undefined) throw new CloudError("the Cloud asked for a blob the manifest does not list");
        await call({ method: "PUT", path: `/v1/assets/blobs/${hash}`, body: new Uint8Array(readFileSync(file)) });
        uploaded++;
      }
    }),
  );
  await call({
    method: "PUT",
    path: `/v1/assets/manifests/${bundle.manifestSha}`,
    body: new TextEncoder().encode(bundle.manifestText),
  });
  io.log(`  assets  ${bundle.files} files, ${uploaded} of ${hashes.length} blobs uploaded`);
}

export type ModuleInputs = {
  project: string;
  /** Emits sprout.generated.js for the project and returns its path. */
  emit: () => Promise<string>;
  sproutd?: string;
  generation?: string;
  out: string;
  /** The bun to run compile-app with. */
  bun: string;
};

/**
 * Operators only: compile the app into a module the way tools/sbcloud-deploy does, the CLI's standalone emit and
 * then sproutd's compile-app against a built generation. Regular deploys send the source to the Cloud to build.
 */
export async function compileModule(input: ModuleInputs): Promise<void> {
  const { sproutd, generation } = input;
  if (!sproutd || !generation)
    throw new CloudError(
      [
        "compiling a module here needs both a sproutd checkout and a built generation (operators only):",
        "  sproutboat deploy --sproutd <sproutd checkout> --generation <built generation>",
        "  (or SPROUTBOAT_SPROUTD and SPROUTBOAT_GENERATION in the environment)",
        "Regular deploys are built by the Cloud: run `sproutboat deploy` without these flags.",
      ].join("\n"),
    );
  const compiler = resolve(sproutd, "build/compile-app.ts");
  if (!existsSync(compiler)) throw new CloudError(`${compiler} not found (--sproutd)`);
  if (!existsSync(resolve(generation, "manifest.json")))
    throw new CloudError(`${resolve(generation)} is not a built generation (--generation)`);
  const unit = await input.emit();
  const run = Bun.spawnSync([input.bun, compiler, resolve(generation), unit, input.out, "--name", input.project], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = run.stdout.toString();
  if (run.exitCode !== 0)
    throw new CloudError(
      `the compile was not admitted (exit ${run.exitCode}):\n${(stdout + run.stderr.toString()).trim().slice(-2000)}`,
    );
  if (!existsSync(input.out) || Bun.file(input.out).size === 0)
    throw new CloudError(`the compiler reported success but wrote no module to ${input.out}`);
}

// ---- Deploy from source: the Cloud builds the module (docs/builds.md in the cloud repo) ----

/** The Cloud accepts a source of at most 8 MiB. */
export const SOURCE_MAX_BYTES = 8 * 1024 * 1024;

/** Ctrl-C while the build runs: the build was asked to cancel (exit 130). */
export class Interrupted extends CloudError {}

type BuildSpec = { hosts: string[]; assets_manifest_ref?: string } & SpecAdditions;
type BuildCli = { version: string; runtime?: string; toolchain?: string };

export type BuildPlan = CloudCredentials &
  SpecExtras & {
    project: string;
    hosts: string[];
    /** The bundled source (sprout.generated.js, the "generated" input kind). */
    sourcePath: string;
    cli: BuildCli;
    assets?: AssetBundle;
    noWait: boolean;
    waitMs?: number;
    pollMs?: number;
    /** Pause before an event stream is reopened. */
    retryMs?: number;
    /** Event stream reconnects before falling back to polling. */
    maxReconnects?: number;
  };

export type BuildView = {
  id: string;
  state: string;
  cached: boolean;
  position: number | null;
  /** Why a queued build is held back (not a failure), e.g. waiting for memory. */
  waiting: string | null;
  error: { code?: string; message: string } | null;
  recordGeneration: number | undefined;
  stats: { wallMs: number | null; peakMemoryBytes: number | null; memoryCapBytes: number | null };
};

export type BuildDeployResult = {
  created: boolean;
  /** Undefined when --no-wait returned before the build finished. */
  generation: number | undefined;
  url: string | undefined;
  applied: boolean | "skipped";
  buildId: string;
  build: BuildView;
};

const int = (value: JsonValue | undefined): number | null => (isSafeInteger(value) ? value : null);

export function parseBuildView(body: JsonObject | undefined): BuildView {
  const id = body?.id;
  const state = body?.state;
  if (!isString(id) || !isString(state)) throw new CloudError("the Cloud's reply was not a build");
  const error = jsonObject(body?.error ?? null);
  const stats = jsonObject(body?.stats ?? null);
  return {
    id,
    state,
    cached: body?.cached === true,
    position: int(body?.position),
    waiting: isString(body?.waiting) ? body.waiting : null,
    error:
      error && isString(error.message)
        ? { code: isString(error.code) ? error.code : undefined, message: error.message }
        : null,
    recordGeneration: isSafeInteger(body?.record_generation) ? body.record_generation : undefined,
    stats: {
      wallMs: int(stats?.wall_ms),
      peakMemoryBytes: int(stats?.peak_memory_bytes),
      memoryCapBytes: int(stats?.memory_cap_bytes),
    },
  };
}

export const formatKiB = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KiB`;
export const formatMB = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`;
export const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The text after the tick: "Built in 4.1 s · peak memory 742 MB (cap 1200 MB)". */
export function formatBuildSummary(view: BuildView): string {
  if (view.cached) return "Built (cached, identical to an earlier build)";
  const parts: string[] = [];
  const { wallMs, peakMemoryBytes, memoryCapBytes } = view.stats;
  if (wallMs !== null) parts.push(`Built in ${formatSeconds(wallMs)}`);
  if (peakMemoryBytes !== null) {
    const cap = memoryCapBytes !== null ? ` (cap ${formatMB(memoryCapBytes)})` : "";
    parts.push(`peak memory ${formatMB(peakMemoryBytes)}${cap}`);
  }
  return parts.length === 0
    ? "Built"
    : parts[0]!.startsWith("Built")
      ? parts.join(" · ")
      : `Built · ${parts.join(" · ")}`;
}

/** The "Building" status line for a queued or running build. */
export function formatBuildState(state: string, position: number | null, waiting: string | null = null): string {
  if (state === "queued") {
    const queued = position === null ? "queued" : `queued (position ${position})`;
    return waiting ? `${queued}, ${waiting}` : queued;
  }
  if (state === "building") return "building";
  return state;
}

/** Each line of a log chunk behind the design's "  | " gutter. */
export function formatLogLines(text: string): string[] {
  return text
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => `${dim("  |")} ${line}`);
}

export type SseFrame = { event: string; id?: string; data: string };
export type SseParse = { frames: SseFrame[]; rest: string };

/**
 * Split a Server-Sent Events buffer into complete frames (blank-line separated). The unfinished tail comes back
 * as `rest` to be joined with the next chunk. Comment lines (": keepalive") are dropped.
 */
export function parseSseFrames(buffer: string): SseParse {
  const text = buffer.replace(/\r\n/g, "\n");
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const part of parts) {
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    let seen = false;
    for (const line of part.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data.push(value);
      else continue;
      seen = true;
    }
    if (seen) frames.push({ event, id, data: data.join("\n") });
  }
  return { frames, rest };
}

/** DELETE /v1/builds/<id>: ask the Cloud to cancel. Safe to call on a build that already finished. */
export async function cancelCloudBuild(credentials: CloudCredentials, id: string): Promise<BuildView> {
  const reply = await makeCall(credentials)({ method: "DELETE", path: `/v1/builds/${id}` });
  return parseBuildView(reply.body);
}

const TERMINAL = new Set(["ready", "failed", "canceled"]);

/**
 * Follow a build to its end: the event stream (resumed with ?after= when it drops, up to `maxReconnects` times),
 * then plain polling of GET /v1/builds/<id>. Returns the final view.
 */
async function followBuild(
  plan: BuildPlan,
  call: CallFn,
  first: BuildView,
  io: CloudIo,
  onState: (state: string, position: number | null, waiting: string | null) => void,
  signal: AbortSignal | undefined,
): Promise<BuildView> {
  const headers = new Headers(authHeaders(plan.token));
  headers.set("accept", "text/event-stream");
  let lastSeq = 0;
  let reconnects = 0;
  const limit = plan.maxReconnects ?? 5;
  while (reconnects <= limit) {
    if (signal?.aborted) throw new Interrupted("build canceled");
    if (reconnects > 0) await io.sleep(plan.retryMs ?? 500);
    reconnects++;
    let response: Response;
    try {
      response = await fetch(`${plan.apiUrl}/v1/builds/${first.id}/events?after=${lastSeq}`, { headers, signal });
    } catch {
      if (signal?.aborted) throw new Interrupted("build canceled");
      continue;
    }
    if (response.status === 401 || response.status === 403)
      throw new CloudError(explainApiFailure(response.status, await response.text(), plan.tokenFromEnv));
    // Any other failure of the stream route: try again, then poll.
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      continue;
    }
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const parsed = parseSseFrames(pending);
        pending = parsed.rest;
        for (const frame of parsed.frames) {
          const body = parseBody(frame.data);
          if (frame.event === "state") {
            onState(
              isString(body?.state) ? body.state : "",
              int(body?.position),
              isString(body?.waiting) ? body.waiting : null,
            );
          } else if (frame.event === "log") {
            const seq = Number(frame.id);
            if (Number.isFinite(seq)) {
              if (seq <= lastSeq) continue;
              lastSeq = seq;
            }
            if (isString(body?.text)) for (const line of formatLogLines(body.text)) io.log(line);
          } else if (frame.event === "done") {
            return parseBuildView(body);
          } else if (frame.event === "error") {
            throw new CloudError(
              isString(body?.message) ? body.message : isString(body?.error) ? body.error : "the build stream failed",
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof CloudError) throw error;
      if (signal?.aborted) throw new Interrupted("build canceled");
    }
    // The stream ended before `done`: reconnect from the last log line seen.
  }
  for (;;) {
    if (signal?.aborted) throw new Interrupted("build canceled");
    const view = parseBuildView((await call({ method: "GET", path: `/v1/builds/${first.id}` })).body);
    onState(view.state, view.position, view.waiting);
    if (TERMINAL.has(view.state)) return view;
    await io.sleep(plan.pollMs ?? 2000);
  }
}

/** 503 and 429 from the build request, as plain sentences. */
function explainBuildRefusal(result: CallResult): string {
  const body = result.body;
  const reason = body?.reason;
  const message = isString(body?.message) ? body.message : isString(body?.error) ? body.error : `HTTP ${result.status}`;
  if (result.status === 503) {
    if (reason === "builds-disabled") return "this Cloud cannot build right now: builds are not enabled on it";
    if (reason === "no-builder")
      return "this Cloud cannot build right now: no builder is available; try again in a few minutes";
    return `this Cloud cannot build right now: ${message}`;
  }
  return message;
}

/**
 * Deploy from source: upload the bundled source by digest, ask the Cloud to build it, follow the log, and wait for
 * a host to apply the record generation the build wrote.
 */
export async function buildAndDeploy(plan: BuildPlan, io: CloudIo, signal?: AbortSignal): Promise<BuildDeployResult> {
  const call = makeCall(plan);
  const bytes = new Uint8Array(readFileSync(plan.sourcePath));
  if (bytes.byteLength > SOURCE_MAX_BYTES)
    throw new CloudError(
      `the bundled source is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; the Cloud accepts at most 8 MiB`,
    );
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CloudError("the bundled source is not valid UTF-8");
  }
  const sha = createHash("sha256").update(bytes).digest("hex");

  // Everything that can refuse the deploy runs before the first upload or write.
  checkServiceBindings(plan.project, plan.services ?? [], plan.compatibilityDate);
  const wiring = await resolveServiceBindings(call, plan.project, plan.services ?? []);
  const { created, assetsRef } = await resolveAssets(call, plan, io);

  const missingBody = (await call({ method: "POST", path: "/v1/sources/missing", json: { sha256: [sha] } })).body
    ?.missing;
  const needed = Array.isArray(missingBody) && missingBody.includes(sha);
  const label = `  Uploading  source ${sha.slice(0, 12)} (${formatKiB(bytes.byteLength)})`;
  if (needed) {
    io.log(label);
    await call({ method: "PUT", path: `/v1/sources/${sha}`, body: bytes });
  } else io.log(`${label}  unchanged`);

  const spec: BuildSpec = { hosts: plan.hosts };
  if (assetsRef !== undefined) spec.assets_manifest_ref = assetsRef;
  applyExtras(spec, wiring, plan.secrets);
  const cli: BuildCli = { version: plan.cli.version };
  if (plan.cli.runtime) cli.runtime = plan.cli.runtime;
  if (plan.cli.toolchain) cli.toolchain = plan.cli.toolchain;
  const build = { v: 1, name: plan.project, cli };
  const accepted = await call({
    method: "POST",
    path: `/v1/apps/${plan.project}/builds`,
    json: { source_sha256: sha, kind: "generated", build, spec },
    ok: [429, 503],
  });
  if (accepted.status === 429 || accepted.status === 503) throw new CloudError(explainBuildRefusal(accepted));
  let view = parseBuildView(accepted.body);
  const url = plan.hosts[0] === undefined ? undefined : `https://${plan.hosts[0]}`;

  let shown = "";
  const onState = (state: string, position: number | null, waiting: string | null) => {
    if (state === "") return;
    const line = `  Building   ${formatBuildState(state, position, waiting)}`;
    if (line === shown || TERMINAL.has(state)) return;
    shown = line;
    io.log(line);
  };

  if (!TERMINAL.has(view.state)) {
    onState(view.state, view.position, view.waiting);
    if (plan.noWait) {
      io.log(`  Build      ${view.id} accepted; status at /v1/builds/${view.id}`);
      return { created, generation: undefined, url, applied: "skipped", buildId: view.id, build: view };
    }
    try {
      view = await followBuild(plan, call, view, io, onState, signal);
    } catch (error) {
      if (error instanceof Interrupted) {
        try {
          await cancelCloudBuild(plan, view.id);
        } catch {
          // The cancel is best effort; the build ends on its own.
        }
      }
      throw error;
    }
  }
  if (view.state === "canceled") throw new CloudError(`build canceled${view.error ? `: ${view.error.message}` : ""}`);
  if (view.state === "failed") {
    const { peakMemoryBytes, memoryCapBytes } = view.stats;
    if (peakMemoryBytes !== null)
      io.log(
        `  peak memory ${formatMB(peakMemoryBytes)}${memoryCapBytes === null ? "" : ` (cap ${formatMB(memoryCapBytes)})`}`,
      );
  }
  if (view.state === "failed") throw new CloudError(`build failed: ${buildFailureHeadline(view.error?.message)}`);
  io.log(ok(formatBuildSummary(view)));
  const generation = view.recordGeneration;
  if (generation === undefined) throw new CloudError("the Cloud's reply carried no record generation");
  if (plan.noWait) return { created, generation, url, applied: "skipped", buildId: view.id, build: view };
  const applied = await waitForApply(call, plan, generation, io, signal);
  return { created, generation, url, applied, buildId: view.id, build: view };
}
