import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type SproutboatConfig } from "./config";
import { jsonObject, type JsonObject, type JsonValue } from "./json";
import type { CloudIo } from "./cloud";
import { buildAndDeploy, deployToCloud, type BuildPlan } from "./cloud-deploy";
import { FAKE_KEY, fakeAppId, startFakeCloud, type FakeOptions } from "./cloud-fake";
import {
  type CloudBindings,
  checkDurableObjectExports,
  describeCloudBindings,
  mapCloudBindings,
  MAX_BINDINGS,
  MAX_CRONS,
  MAX_QUEUE_CONSUMERS,
} from "./cloud-bindings";

const io: CloudIo = {
  log: () => {},
  warn: () => {},
  interactive: false,
  openUrl: () => true,
  sleep: async () => {},
  choose: async (_q, choices) => choices[0]!,
};

/** A config as the CLI reads it: through the shared parser, so the tests see what a real sproutboat.jsonc yields. */
function config(extra: JsonObject): SproutboatConfig {
  const r = parseConfig(
    JSON.stringify({ name: "app", main: "src/index.js", compatibility_date: "2026-11-18", ...extra }),
  );
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
}
const failure = (run: () => CloudBindings): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("did not throw");
};

describe("mapCloudBindings", () => {
  test("every kind: names, resource ids, config", () => {
    const mapped = mapCloudBindings(
      config({
        kv_namespaces: ["SESSIONS"],
        d1_databases: ["DB"],
        r2_buckets: ["UPLOADS"],
        queues: ["EMAILS"],
        analytics_engine_datasets: ["METRICS"],
        durable_objects: { VIEWS: "ViewCounter", ROOM: "ChatRoom" },
        ratelimiters: [{ binding: "THROTTLE", limit: 3, period: 60 }],
        secrets: ["ADMIN_TOKEN"],
        assets: { directory: "site", binding: "ASSETS" },
        triggers: { crons: ["*/1 * * * *"] },
      }),
      1,
    );
    expect(mapped.bindings).toEqual([
      { name: "SESSIONS", kind: "kv", resource_id: "sessions", config: {} },
      { name: "DB", kind: "d1", resource_id: "db", config: {} },
      { name: "UPLOADS", kind: "r2", resource_id: "uploads", config: {} },
      { name: "EMAILS", kind: "queue", resource_id: "emails", config: { queue: "EMAILS" } },
      { name: "METRICS", kind: "ae", resource_id: null, config: {} },
      { name: "VIEWS", kind: "do", resource_id: null, config: { class_name: "ViewCounter" } },
      { name: "ROOM", kind: "do", resource_id: null, config: { class_name: "ChatRoom" } },
      { name: "THROTTLE", kind: "ratelimit", resource_id: null, config: { limit: 3, period: 60 } },
      { name: "ASSETS", kind: "assets", resource_id: null, config: {} },
      { name: "ADMIN_TOKEN", kind: "secret", resource_id: null, config: {} },
    ]);
    expect(mapped.crons).toEqual(["*/1 * * * *"]);
    expect(mapped.queue_consumers).toEqual([
      { queue: "emails", max_batch_size: 10, max_batch_timeout_ms: 0, max_retries: 3, dead_letter_queue: null },
    ]);
    expect(mapped.warnings).toEqual([]);
  });

  test("queue settings become the consumer: seconds to milliseconds, the queue name as resource id, the dead letter queue", () => {
    const mapped = mapCloudBindings(
      config({
        queues: [
          {
            binding: "JOBS",
            queue: "job-queue",
            max_batch_size: 5,
            max_batch_timeout: 1.5,
            max_retries: 7,
            retry_delay: 30,
            dead_letter_queue: "dead-jobs",
          },
          { binding: "DEAD", queue: "dead-jobs" },
        ],
      }),
    );
    expect(mapped.bindings[0]).toEqual({
      name: "JOBS",
      kind: "queue",
      resource_id: "job-queue",
      config: { queue: "job-queue", retry_delay: 30 },
    });
    expect(mapped.queue_consumers).toEqual([
      {
        queue: "job-queue",
        max_batch_size: 5,
        max_batch_timeout_ms: 1500,
        max_retries: 7,
        dead_letter_queue: "dead-jobs",
      },
      { queue: "dead-jobs", max_batch_size: 10, max_batch_timeout_ms: 0, max_retries: 3, dead_letter_queue: null },
    ]);
  });

  test("an empty config maps to nothing", () => {
    expect(mapCloudBindings(config({}))).toEqual({ bindings: [], crons: [], queue_consumers: [], warnings: [] });
  });

  test("an account-level id is ignored with a warning: each Cloud app's storage is private", () => {
    const id = "0123456789abcdef01234567";
    const mapped = mapCloudBindings(
      config({ kv_namespaces: [{ binding: "LINKS", id: `kv_${id}` }], queues: [{ binding: "Q", id: `queue_${id}` }] }),
    );
    expect(mapped.bindings.map((b) => [b.name, b.resource_id])).toEqual([
      ["LINKS", "links"],
      ["Q", "q"],
    ]);
    expect(mapped.warnings).toHaveLength(1);
    expect(mapped.warnings[0]).toContain("kv_namespaces.LINKS, queues.Q");
    expect(mapped.warnings[0]).toContain("private");
  });

  test("crons: extra spaces are collapsed; more than 16 are refused", () => {
    expect(mapCloudBindings(config({ triggers: { crons: ["0  3 * *   *"] } })).crons).toEqual(["0 3 * * *"]);
    const many = Array.from({ length: MAX_CRONS + 1 }, (_, i) => `${i} * * * *`);
    expect(failure(() => mapCloudBindings(config({ triggers: { crons: many } })))).toContain(`at most ${MAX_CRONS}`);
    const sixteen = many.slice(0, MAX_CRONS);
    expect(mapCloudBindings(config({ triggers: { crons: sixteen } })).crons).toHaveLength(MAX_CRONS);
  });

  test("a cron with characters the Cloud refuses is named", () => {
    const error = failure(() => mapCloudBindings(config({ triggers: { crons: ["0 3 * * $"] } })));
    expect(error).toContain('"0 3 * * $"');
  });

  test("more than 16 queues is more than 16 consumers: refused", () => {
    const queues = Array.from({ length: MAX_QUEUE_CONSUMERS + 1 }, (_, i) => `Q${i}`);
    const error = failure(() => mapCloudBindings(config({ queues })));
    expect(error).toContain(`${MAX_QUEUE_CONSUMERS + 1} queues`);
    expect(error).toContain(`at most ${MAX_QUEUE_CONSUMERS}`);
    expect(mapCloudBindings(config({ queues: queues.slice(0, MAX_QUEUE_CONSUMERS) })).queue_consumers).toHaveLength(
      MAX_QUEUE_CONSUMERS,
    );
  });

  test("the 64-binding limit counts the service bindings the deploy adds", () => {
    const kv = Array.from({ length: MAX_BINDINGS }, (_, i) => `K${i}`);
    expect(mapCloudBindings(config({ kv_namespaces: kv })).bindings).toHaveLength(MAX_BINDINGS);
    expect(failure(() => mapCloudBindings(config({ kv_namespaces: kv }), 1))).toContain(`at most ${MAX_BINDINGS}`);
  });

  test("a name that cannot be a resource id says which", () => {
    const long = `A${"B".repeat(64)}`;
    const error = failure(() => mapCloudBindings(config({ d1_databases: [long] })));
    expect(error).toContain("d1_databases binding");
    expect(error).toContain("1 to 64 characters");
  });

  test("a default queue name that collides with another queue's lowercase name is refused", () => {
    const error = failure(() =>
      mapCloudBindings(config({ queues: ["EMAILS", { binding: "OTHER", queue: "emails" }] })),
    );
    expect(error).toContain('"emails"');
  });
});

describe("checkDurableObjectExports", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sb-do-"));
    await mkdir(join(dir, "src"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const check = async (source: string, durable_objects: Record<string, string>) => {
    await writeFile(join(dir, "src/index.js"), source);
    return checkDurableObjectExports(config({ durable_objects }), dir);
  };

  test("accepts a class exported inline, in a list, renamed on export, or re-exported", async () => {
    await check("export class A {}\nexport default {};", { X: "A" });
    await check("class B {}\nexport { B };", { X: "B" });
    await check("class C {}\nexport { C as D };", { X: "D" });
    await check('export { E } from "./e.js";', { X: "E" });
    await check("export default class F {}\nexport async function g() {}", { X: "F" });
  });

  test("an export * cannot be judged and passes", async () => {
    await check('export * from "./classes.js";', { X: "Anything" });
  });

  test("refuses a class the entry does not export, naming the binding, class and file", async () => {
    const error = await check("class A {}\nexport default {};", { VIEWS: "A" }).catch((e: Error) => e.message);
    expect(error).toContain("VIEWS");
    expect(error).toContain('"A"');
    expect(error).toContain("src/index.js");
    expect(error).toContain("export class A");
  });

  test("a class only mentioned in a comment or a string is not exported", async () => {
    const error = await check('// export class A {}\nconst s = "export class A";\nexport default {};', {
      V: "A",
    }).catch((e: Error) => e.message);
    expect(error).toContain('"A"');
  });

  test("an entry the CLI cannot read is left to the build", () => {
    checkDurableObjectExports(config({ durable_objects: { V: "A" } }), join(dir, "nowhere"));
  });
});

describe("describeCloudBindings", () => {
  test("one line per binding, consumer and cron", () => {
    const lines = describeCloudBindings(
      mapCloudBindings(
        config({
          d1_databases: ["DB"],
          queues: [{ binding: "Q", dead_letter_queue: "dlq" }],
          durable_objects: { ROOM: "ChatRoom" },
          ratelimiters: [{ binding: "T", limit: 3, period: 60 }],
          triggers: { crons: ["* * * * *"] },
        }),
      ),
    );
    expect(lines).toEqual([
      "d1        DB  -> db",
      "queue     Q  -> q",
      "do        ROOM  class ChatRoom",
      "ratelimit T  3 per 60 s",
      "consumer  q  batch 10 / 0 ms, 3 retries, dead letters to dlq",
      "cron      * * * * *",
    ]);
  });
});

describe("what a deploy sends", () => {
  let work: string;
  let sourcePath: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "sb-bindings-"));
    sourcePath = join(work, "sprout.generated.js");
    await writeFile(sourcePath, "export default { fetch() { return new Response('hi'); } };\n");
    await writeFile(join(work, "app.so"), "module-bytes");
  });
  afterEach(() => rm(work, { recursive: true, force: true }));
  async function withCloud(options: FakeOptions, run: (cloud: ReturnType<typeof startFakeCloud>) => Promise<void>) {
    const cloud = startFakeCloud(options);
    try {
      await run(cloud);
    } finally {
      cloud.stop();
    }
  }
  const creds = (apiUrl: string) => ({ apiUrl, token: FAKE_KEY, tokenFromEnv: false });
  const sentSpec = (spec: JsonValue | undefined): JsonObject => jsonObject(spec ?? null) ?? {};
  /** `key` of every object in a list a spec sent. */
  const listed = (list: JsonValue | undefined, key: string) =>
    (Array.isArray(list) ? list : []).map((entry) => jsonObject(entry)?.[key]);
  const everything = () =>
    mapCloudBindings(
      config({
        kv_namespaces: ["SESSIONS"],
        d1_databases: ["DB"],
        r2_buckets: ["UPLOADS"],
        queues: [{ binding: "EMAILS", max_retries: 5, dead_letter_queue: "dead" }],
        durable_objects: { ROOM: "ChatRoom" },
        ratelimiters: [{ binding: "THROTTLE", limit: 3, period: 60 }],
        triggers: { crons: ["*/1 * * * *"] },
      }),
      1,
    );

  test("a build deploy puts bindings, crons and queue consumers in the build spec, with the service binding last", async () => {
    await withCloud({ otherApps: ["quote-service"] }, async (cloud) => {
      const plan: BuildPlan = {
        ...creds(cloud.url),
        project: "hello",
        hosts: ["hello.acme.sproutboat.app"],
        sourcePath,
        cli: { version: "9.9.9" },
        noWait: false,
        services: [{ binding: "PEER", service: "quote-service" }],
        compatibilityDate: "2026-11-18",
        cloudBindings: everything(),
      };
      await buildAndDeploy(plan, io);
      const spec = sentSpec(cloud.buildRequests[0]!.spec);
      expect(listed(spec.bindings, "name")).toEqual([
        "SESSIONS",
        "DB",
        "UPLOADS",
        "EMAILS",
        "ROOM",
        "THROTTLE",
        "PEER",
      ]);
      expect(spec.crons).toEqual(["*/1 * * * *"]);
      expect(spec.queue_consumers).toEqual([
        { queue: "emails", max_batch_size: 10, max_batch_timeout_ms: 0, max_retries: 5, dead_letter_queue: "dead" },
      ]);
      expect(spec.services).toEqual({ PEER: fakeAppId("quote-service") });
      // The stored app carries the same.
      expect(cloud.spec.crons).toEqual(["*/1 * * * *"]);
      expect(cloud.spec.queue_consumers).toHaveLength(1);
    });
  });

  test("a module deploy sends them in the PUT", async () => {
    await withCloud({}, async (cloud) => {
      await deployToCloud(
        {
          ...creds(cloud.url),
          project: "hello",
          hosts: ["hello.acme.sproutboat.app"],
          modulePath: join(work, "app.so"),
          noWait: true,
          cloudBindings: everything(),
        },
        io,
      );
      expect(listed(cloud.spec.bindings, "kind")).toEqual(["kv", "d1", "r2", "queue", "do", "ratelimit"]);
      expect(cloud.spec.crons).toEqual(["*/1 * * * *"]);
    });
  });

  test("an app with no bindings sends none of the keys (the wire stays what it was)", async () => {
    await withCloud({}, async (cloud) => {
      await buildAndDeploy(
        {
          ...creds(cloud.url),
          project: "hello",
          hosts: ["hello.acme.sproutboat.app"],
          sourcePath,
          cli: { version: "9.9.9" },
          noWait: true,
          cloudBindings: mapCloudBindings(config({})),
        },
        io,
      );
      expect(Object.keys(sentSpec(cloud.buildRequests[0]!.spec))).toEqual(["hosts"]);
    });
  });
});
