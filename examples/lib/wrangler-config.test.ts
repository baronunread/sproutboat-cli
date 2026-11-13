import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config";
import { toWranglerConfig } from "./wrangler-config";

const translate = (source: string, max = "2026-11-10") => {
  const parsed = parseConfig(source);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return toWranglerConfig(parsed.value, "/work/app/sproutboat.jsonc", max);
};

test("a bare app keeps its name, an absolute main and the date, lowered to what workerd knows", () => {
  expect(translate('{ "name": "hello", "main": "src/index.ts", "compatibility_date": "2026-11-18" }')).toEqual({
    name: "hello",
    main: "/work/app/src/index.ts",
    compatibility_date: "2026-11-10",
  });
  expect(translate('{ "name": "hello", "main": "src/index.ts", "compatibility_date": "2026-09-28" }')).toHaveProperty(
    "compatibility_date",
    "2026-09-28",
  );
});

test("every binding kind becomes the one wrangler dev reads", () => {
  const out = translate(`{
    "name": "all", "main": "src/index.ts", "compatibility_date": "2026-10-01",
    "vars": { "A": "1" },
    "secrets": ["TOKEN"],
    "kv_namespaces": ["MY_KV"],
    "d1_databases": [{ "binding": "DB", "id": "d1_0123456789abcdef01234567" }],
    "r2_buckets": ["FILES"],
    "queues": [{ "binding": "JOBS", "queue": "jobs", "max_batch_size": 5 }],
    "analytics_engine_datasets": ["EVENTS"],
    "ratelimiters": [{ "binding": "API", "limit": 3, "period": 60 }],
    "durable_objects": { "COUNTER": "Counter" },
    "services": [{ "binding": "PEER", "service": "other" }],
    "assets": { "directory": "public", "binding": "ASSETS", "run_sprout_first": ["/api/*"] },
    "version_metadata": "VERSION",
    "triggers": { "crons": ["*/1 * * * *"] }
  }`);
  expect(out.vars).toEqual({ A: "1" });
  expect(out.kv_namespaces).toEqual([{ binding: "MY_KV", id: "my-kv" }]);
  expect(out.d1_databases?.[0]).toMatchObject({ binding: "DB", database_name: "db" });
  expect(out.d1_databases?.[0]?.database_id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  expect(out.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "files-bucket" }]);
  expect(out.queues).toEqual({
    producers: [{ binding: "JOBS", queue: "jobs" }],
    consumers: [{ queue: "jobs", max_batch_size: 5 }],
  });
  expect(out.analytics_engine_datasets).toEqual([{ binding: "EVENTS" }]);
  expect(out.ratelimits).toEqual([{ name: "API", namespace_id: "1001", simple: { limit: 3, period: 60 } }]);
  expect(out.durable_objects).toEqual({ bindings: [{ name: "COUNTER", class_name: "Counter" }] });
  expect(out.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Counter"] }]);
  expect(out.services).toEqual([{ binding: "PEER", service: "other" }]);
  expect(out.assets).toEqual({ directory: "/work/app/public", binding: "ASSETS", run_worker_first: ["/api/*"] });
  expect(out.version_metadata).toEqual({ binding: "VERSION" });
  expect(out.triggers).toEqual({ crons: ["*/1 * * * *"] });
  // Secrets are not in wrangler.jsonc: they go in .dev.vars.
  expect(JSON.stringify(out)).not.toContain("TOKEN");
});
