/**
 * A `sproutboat.jsonc` as the `wrangler.jsonc` of the same Worker, so the examples can be run under workerd.
 *
 * Only what a local `wrangler dev` needs: bindings get placeholder ids (local storage ignores them), paths are made
 * absolute, secrets are not here (they go in a `.dev.vars` file next to the result). Pure, so a test can read it.
 */
import { dirname, resolve } from "node:path";
import { queueSettings, resourceRefs, type SproutboatConfig } from "../../../src/config";

interface QueueConsumer {
  queue: string;
  max_batch_size?: number;
  max_retries?: number;
}

export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  vars?: Record<string, string>;
  kv_namespaces?: Array<{ binding: string; id: string }>;
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  queues?: {
    producers: Array<{ binding: string; queue: string }>;
    consumers: QueueConsumer[];
  };
  analytics_engine_datasets?: Array<{ binding: string }>;
  ratelimits?: Array<{ name: string; namespace_id: string; simple: { limit: number; period: number } }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  migrations?: Array<{ tag: string; new_sqlite_classes: string[] }>;
  services?: Array<{ binding: string; service: string }>;
  assets?: {
    directory: string;
    binding?: string;
    not_found_handling?: string;
    run_worker_first?: boolean | string[];
  };
  version_metadata?: { binding: string };
  triggers?: { crons: string[] };
}

/** Names for the resources Cloudflare names itself: lowercase letters, digits and hyphens. */
const slug = (binding: string) => binding.toLowerCase().replaceAll("_", "-");

/** A stable fake id in the shape D1 wants (a UUID). */
function fakeUuid(seed: string): string {
  const hex = Buffer.from(seed.padEnd(16, "0")).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @param configPath absolute path of the sproutboat.jsonc, so `main` and the assets directory resolve from it
 * @param maxCompatibilityDate the newest date the installed workerd knows; the date is lowered to it, which is
 *   the one place the two runtimes' calendars differ
 */
export function toWranglerConfig(
  config: SproutboatConfig,
  configPath: string,
  maxCompatibilityDate: string,
): WranglerConfig {
  const base = dirname(configPath);
  const out: WranglerConfig = {
    name: config.name,
    main: resolve(base, config.main),
    compatibility_date:
      config.compatibility_date > maxCompatibilityDate ? maxCompatibilityDate : config.compatibility_date,
  };
  if (config.vars) out.vars = { ...config.vars };
  const kv = resourceRefs(config.kv_namespaces);
  if (kv.length) out.kv_namespaces = kv.map(({ binding }) => ({ binding, id: slug(binding) }));
  const d1 = resourceRefs(config.d1_databases);
  if (d1.length)
    out.d1_databases = d1.map(({ binding }) => ({
      binding,
      database_name: slug(binding),
      database_id: fakeUuid(binding),
    }));
  const r2 = resourceRefs(config.r2_buckets);
  if (r2.length) out.r2_buckets = r2.map(({ binding }) => ({ binding, bucket_name: `${slug(binding)}-bucket` }));
  const queues = queueSettings(config.queues);
  if (queues.length) {
    out.queues = {
      producers: queues.map(({ binding, queue }) => ({ binding, queue })),
      consumers: queues.map((entry) => {
        const consumer: QueueConsumer = { queue: entry.queue };
        if (entry.maxBatchSize !== undefined) consumer.max_batch_size = entry.maxBatchSize;
        if (entry.maxRetries !== undefined) consumer.max_retries = entry.maxRetries;
        return consumer;
      }),
    };
  }
  if (config.analytics_engine_datasets?.length)
    out.analytics_engine_datasets = config.analytics_engine_datasets.map((binding) => ({ binding }));
  if (config.ratelimiters?.length)
    out.ratelimits = config.ratelimiters.map(({ binding, limit, period }, at) => ({
      name: binding,
      namespace_id: String(1001 + at),
      simple: { limit, period },
    }));
  const objects = Object.entries(config.durable_objects ?? {});
  if (objects.length) {
    out.durable_objects = { bindings: objects.map(([name, class_name]) => ({ name, class_name })) };
    out.migrations = [{ tag: "v1", new_sqlite_classes: objects.map(([, className]) => className) }];
  }
  if (config.services?.length) out.services = config.services.map(({ binding, service }) => ({ binding, service }));
  if (config.assets) {
    const assets: NonNullable<WranglerConfig["assets"]> = { directory: resolve(base, config.assets.directory) };
    if (config.assets.binding) assets.binding = config.assets.binding;
    if (config.assets.not_found_handling) assets.not_found_handling = config.assets.not_found_handling;
    if (config.assets.run_sprout_first !== undefined) assets.run_worker_first = config.assets.run_sprout_first;
    out.assets = assets;
  }
  if (config.version_metadata) out.version_metadata = { binding: config.version_metadata };
  if (config.triggers?.crons?.length) out.triggers = { crons: [...config.triggers.crons] };
  return out;
}
