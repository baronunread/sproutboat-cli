/**
 * `sproutboat.jsonc` bindings as the Sproutboat Cloud's app record carries them (sproutboat-cloud `src/record.ts`,
 * `bindings`, `crons`, `queue_consumers`). The Cloud validates the same shape again on `PUT /v1/apps/<app>` and
 * `POST /v1/apps/<app>/builds`; checking here means a mistake fails before anything is uploaded, in the CLI's words.
 *
 * Where a resource id comes from: on the Cloud each app's storage is private to it, so the binding is the name
 * (`d1_databases: ["DB"]` is `d1/DB`, the name `d1 execute --remote` and `r2 object` address). A binding that needs a
 * `resource_id` (kv, d1, r2, queue) gets its own name in lowercase, because the record's resource ids are lowercase;
 * a queue gets its queue name. Nothing is provisioned: the host creates the storage on first use.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { queueSettings, resourceRefs, type SproutboatConfig } from "./config";
import { CloudError } from "./cloud";

export type RecordBinding = {
  name: string;
  kind: "kv" | "d1" | "r2" | "queue" | "do" | "ae" | "ratelimit" | "assets" | "secret";
  resource_id: string | null;
  config: Record<string, string | number>;
};
export type RecordQueueConsumer = {
  queue: string;
  max_batch_size: number;
  max_batch_timeout_ms: number;
  max_retries: number;
  dead_letter_queue: string | null;
};
export type CloudBindings = {
  bindings: RecordBinding[];
  crons: string[];
  queue_consumers: RecordQueueConsumer[];
  /** Things the Cloud ignores, said once before the deploy. */
  warnings: string[];
};

/** The record's own limits (sproutboat-cloud `src/record.ts`). */
export const MAX_BINDINGS = 64;
export const MAX_CRONS = 16;
export const MAX_QUEUE_CONSUMERS = 16;
const RESOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CRON_CHARS_RE = /^[0-9A-Za-z*,/ -]+$/;

/** Cloudflare's defaults for a queue consumer, which the runtime applies when sproutboat.jsonc leaves a setting out. */
const QUEUE_DEFAULTS = { maxBatchSize: 10, maxBatchTimeout: 0, maxRetries: 3 };

/** `resource_id` for a binding or queue name: lowercase, so `DB` is `db` and `EMAILS` is `emails`. */
function resourceIdFor(what: string, name: string): string {
  const id = name.toLowerCase();
  if (!RESOURCE_ID_RE.test(id))
    throw new CloudError(
      `${what} "${name}" cannot be a Cloud resource name: lowercased it must be 1 to 64 characters, start with a letter or digit, and use only letters, digits, "_" and "-"`,
    );
  return id;
}

/** A cron as the Cloud stores it: single spaces, five fields, at most 128 characters of the allowed set. */
function normalizeCron(expression: string): string {
  const cron = expression.trim().split(/\s+/).join(" ");
  if (cron.length > 128 || !CRON_CHARS_RE.test(cron) || cron.split(" ").length !== 5)
    throw new CloudError(
      `triggers.crons: "${expression}" is not a cron the Cloud accepts (5 fields of digits, letters and * , / -, at most 128 characters)`,
    );
  return cron;
}

type Mappable = Pick<
  SproutboatConfig,
  | "kv_namespaces"
  | "d1_databases"
  | "r2_buckets"
  | "queues"
  | "analytics_engine_datasets"
  | "durable_objects"
  | "ratelimiters"
  | "secrets"
  | "assets"
  | "triggers"
>;

/**
 * Every binding kind in sproutboat.jsonc as a record entry, plus `crons` and one `queue_consumers` entry per queue
 * (the worker consumes every queue it binds). `serviceBindings` is how many service bindings the deploy adds, so the
 * 64-binding limit counts them. Throws CloudError for anything the Cloud would refuse.
 */
export function mapCloudBindings(config: Mappable, serviceBindings = 0): CloudBindings {
  const bindings: RecordBinding[] = [];
  const warnings: string[] = [];
  const pinned: string[] = [];

  for (const [kind, field] of [
    ["kv", "kv_namespaces"],
    ["d1", "d1_databases"],
    ["r2", "r2_buckets"],
  ] as const)
    for (const ref of resourceRefs(config[field])) {
      if (ref.id !== undefined) pinned.push(`${field}.${ref.binding}`);
      bindings.push({
        name: ref.binding,
        kind,
        resource_id: resourceIdFor(`${field} binding`, ref.binding),
        config: {},
      });
    }

  const queue_consumers: RecordQueueConsumer[] = [];
  const queueNames = new Set<string>();
  for (const queue of queueSettings(config.queues)) {
    const resource = resourceIdFor("queue", queue.queue);
    if (queueNames.has(resource))
      throw new CloudError(
        `queues: two bindings name the queue "${resource}" (queue names are lowercase on the Cloud)`,
      );
    queueNames.add(resource);
    const settings: RecordBinding["config"] = { queue: queue.queue };
    if (queue.retryDelay !== undefined) settings.retry_delay = queue.retryDelay;
    bindings.push({ name: queue.binding, kind: "queue", resource_id: resource, config: settings });
    queue_consumers.push({
      queue: resource,
      max_batch_size: queue.maxBatchSize ?? QUEUE_DEFAULTS.maxBatchSize,
      max_batch_timeout_ms: Math.round((queue.maxBatchTimeout ?? QUEUE_DEFAULTS.maxBatchTimeout) * 1000),
      max_retries: queue.maxRetries ?? QUEUE_DEFAULTS.maxRetries,
      dead_letter_queue:
        queue.deadLetterQueue === undefined ? null : resourceIdFor("dead_letter_queue", queue.deadLetterQueue),
    });
  }
  for (const ref of resourceRefs(config.queues)) if (ref.id !== undefined) pinned.push(`queues.${ref.binding}`);

  for (const name of config.analytics_engine_datasets ?? [])
    bindings.push({ name, kind: "ae", resource_id: null, config: {} });
  for (const [name, className] of Object.entries(config.durable_objects ?? {}))
    bindings.push({ name, kind: "do", resource_id: null, config: { class_name: className } });
  for (const limiter of config.ratelimiters ?? [])
    bindings.push({
      name: limiter.binding,
      kind: "ratelimit",
      resource_id: null,
      config: { limit: limiter.limit, period: limiter.period },
    });
  if (config.assets?.binding)
    bindings.push({ name: config.assets.binding, kind: "assets", resource_id: null, config: {} });
  for (const name of config.secrets ?? []) bindings.push({ name, kind: "secret", resource_id: null, config: {} });

  if (bindings.length + serviceBindings > MAX_BINDINGS)
    throw new CloudError(
      `sproutboat.jsonc declares ${bindings.length + serviceBindings} bindings (secrets, services and assets count); the Cloud takes at most ${MAX_BINDINGS} per app`,
    );
  if (queue_consumers.length > MAX_QUEUE_CONSUMERS)
    throw new CloudError(
      `sproutboat.jsonc binds ${queue_consumers.length} queues, and each one is consumed by the app; the Cloud takes at most ${MAX_QUEUE_CONSUMERS} queue consumers per app`,
    );
  const crons = (config.triggers?.crons ?? []).map(normalizeCron);
  if (crons.length > MAX_CRONS)
    throw new CloudError(`triggers.crons lists ${crons.length} crons; the Cloud takes at most ${MAX_CRONS} per app`);

  if (pinned.length > 0)
    warnings.push(
      `${pinned.join(", ")} pin${pinned.length === 1 ? "s" : ""} an account-level id; on the Cloud each app's storage is private to it, so the id is ignored and the app gets its own`,
    );
  return { bindings, crons, queue_consumers, warnings };
}

/** The names a module exports, as far as its source says. `null` when an `export *` hides some. */
function exportedNames(source: string): Set<string> | null {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  if (/\bexport\s*\*\s*(?!as\b)from\b/.test(code)) return null;
  const names = new Set<string>();
  for (const m of code.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ))
    names.add(m[1]!);
  for (const m of code.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g))
    for (const part of m[1]!.split(",")) {
      const exported = part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (exported) names.add(exported);
    }
  for (const m of code.matchAll(/\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\b/g)) names.add(m[1]!);
  return names;
}

/**
 * Every class named in `durable_objects` must be exported by the entry module, or the app starts and then fails at the
 * first Durable Object call. Checked from the source text: a source with an `export *` cannot be judged and passes, and so
 * does an entry the CLI cannot read (the build reports that itself).
 */
export function checkDurableObjectExports(config: Mappable & Pick<SproutboatConfig, "main">, directory: string): void {
  const classes = Object.entries(config.durable_objects ?? {});
  if (classes.length === 0) return;
  const entry = resolve(directory, config.main);
  if (!existsSync(entry)) return;
  const exported = exportedNames(readFileSync(entry, "utf8"));
  if (exported === null) return;
  for (const [binding, className] of classes)
    if (!exported.has(className))
      throw new CloudError(
        `durable_objects ${binding} names the class "${className}", which ${config.main} does not export; add \`export class ${className}\` (or re-export it) so the Cloud can run it`,
      );
}

/** The plan as lines, for `deploy` and `--dry-run`: what each binding becomes on the Cloud. */
export function describeCloudBindings(plan: CloudBindings): string[] {
  const lines: string[] = [];
  for (const b of plan.bindings) {
    const target =
      b.kind === "do"
        ? `class ${String(b.config.class_name)}`
        : b.kind === "ratelimit"
          ? `${String(b.config.limit)} per ${String(b.config.period)} s`
          : b.resource_id !== null
            ? `-> ${b.resource_id}`
            : "";
    lines.push(`${b.kind.padEnd(9)} ${b.name}${target ? `  ${target}` : ""}`);
  }
  for (const c of plan.queue_consumers)
    lines.push(
      `consumer  ${c.queue}  batch ${c.max_batch_size} / ${c.max_batch_timeout_ms} ms, ${c.max_retries} retries${c.dead_letter_queue ? `, dead letters to ${c.dead_letter_queue}` : ""}`,
    );
  for (const cron of plan.crons) lines.push(`cron      ${cron}`);
  return lines;
}
