/**
 * `sproutboat types` end to end: the command writes the file, `--check` tells whether it is current, the legacy file
 * is cleaned up, and the generated types make a Workers-style project typecheck with `tsc` (and make mistakes fail).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_TYPES_HEADER } from "./types-gen";

const REPO = resolve(import.meta.dir, "..");
const TSC = join(REPO, "node_modules/.bin/tsc");

let root: string;

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, NO_COLOR: "1", SPROUTBOAT_NO_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
const cli = (args: string[], cwd: string) => run([process.execPath, join(REPO, "src/main.ts"), ...args], cwd);

const CONFIG = `{
  "name": "typed",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-18",
  "vars": { "GREETING": "Hello" },
  "secrets": ["TOKEN"],
  "kv_namespaces": ["KV"],
  "d1_databases": ["DB"],
  "r2_buckets": ["BUCKET"],
  "queues": ["JOBS"],
  "analytics_engine_datasets": ["EVENTS"],
  "ratelimiters": [{ "binding": "RL", "limit": 3, "period": 60 }],
  "durable_objects": { "COUNTER": "Counter" },
  "services": [{ "binding": "PEER", "service": "other" }],
  "assets": { "directory": "public", "binding": "ASSETS" },
  "triggers": { "crons": ["*/5 * * * *"] }
}
`;

// Every binding, used the way Workers code uses it.
const HANDLER = `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  async increment(by = 1): Promise<number> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + by;
    await this.ctx.storage.put("n", n);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return n;
  }
  async alarm() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (a INTEGER)");
    await this.env.KV.put("alarm", "1");
  }
}

export class Greeter extends WorkerEntrypoint<Env> {
  async greet(name: string) {
    return \`\${this.env.GREETING}, \${name}\`;
  }
}

interface Job {
  email: string;
}

export default {
  async fetch(request, env, ctx) {
    const greeting: "Hello" = env.GREETING;
    const token: string = env.TOKEN;
    await env.KV.put("k", "v", { expirationTtl: 120 });
    const value: string | null = await env.KV.get("k");
    const { keys } = await env.KV.list({ prefix: "k" });
    const row = await env.DB.prepare("SELECT 1 AS n").first<{ n: number }>();
    const { results, meta } = await env.DB.prepare("SELECT * FROM t").bind(1).all();
    await env.DB.exec("CREATE TABLE IF NOT EXISTS t (a INTEGER)");
    await env.BUCKET.put("o", request.body);
    const object = await env.BUCKET.get("o");
    const headers = new Headers();
    object?.writeHttpMetadata(headers);
    await env.JOBS.send({ email: "a@example.com" } satisfies Job);
    env.EVENTS.writeDataPoint({ blobs: ["a"], doubles: [1] });
    const { success } = await env.RL.limit({ key: "k" });
    const asset = await env.ASSETS.fetch(request);
    const peer = await env.PEER.fetch(new Request("https://peer/"));
    const next: number = await env.COUNTER.getByName("a").increment();
    const stub = env.COUNTER.get(env.COUNTER.idFromName("b"));
    const viaFetch: Response = await stub.fetch("https://do/");
    ctx.waitUntil(Promise.resolve());
    return Response.json({ greeting, token, value, keys, row, results, meta, success, asset, peer, next, viaFetch });
  },
  async scheduled(controller, env) {
    await env.KV.put("cron", controller.cron + controller.scheduledTime);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      await env.KV.put(message.id, JSON.stringify(message.body));
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, Job>;
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [], "strict": true, "noEmit": true, "skipLibCheck": false
  },
  "include": ["src", "worker-configuration.d.ts"]
}
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-types-cli-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  // What `npm install sproutboat` does: the package, found as node_modules/sproutboat.
  await symlink(REPO, join(root, "node_modules/sproutboat"));
  await writeFile(join(root, "sproutboat.jsonc"), CONFIG);
  await writeFile(join(root, "src/index.ts"), HANDLER);
  await writeFile(join(root, "tsconfig.json"), TSCONFIG);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sproutboat types", () => {
  test("writes worker-configuration.d.ts, and --check agrees until the config moves on", async () => {
    const first = await cli(["types"], root);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("wrote worker-configuration.d.ts");
    const file = await readFile(join(root, "worker-configuration.d.ts"), "utf8");
    expect(file).toContain('GREETING: "Hello";');
    expect(file).toContain('COUNTER: DurableObjectNamespaceAsync<import("./src/index").Counter>;');

    const current = await cli(["types", "--check"], root);
    expect(current.code).toBe(0);
    expect(current.stdout).toContain("up to date");

    await writeFile(
      join(root, "sproutboat.jsonc"),
      CONFIG.replace('"secrets": ["TOKEN"],', '"secrets": ["TOKEN", "OTHER"],'),
    );
    const stale = await cli(["types", "--check"], root);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("out of date");
    expect(await readFile(join(root, "worker-configuration.d.ts"), "utf8")).toBe(file);
    await writeFile(join(root, "sproutboat.jsonc"), CONFIG);
  });

  test("an output path, flags, and a missing file for --check", async () => {
    const missing = await cli(["types", "--check", "out/env.d.ts"], root);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("does not exist");

    const written = await cli(["types", "out/env.d.ts", "--env-interface=MyEnv", "--strict-vars=false"], root);
    expect(written.code).toBe(0);
    const file = await readFile(join(root, "out/env.d.ts"), "utf8");
    expect(file).toContain("interface MyEnv extends __BaseMyEnv {}");
    expect(file).toContain("GREETING: string;");
    expect(file).toContain('import("../src/index").Counter');
    const check = await cli(["types", "out/env.d.ts", "--env-interface=MyEnv", "--strict-vars=false", "--check"], root);
    expect(check.code).toBe(0);
    await rm(join(root, "out"), { recursive: true });
  });

  test("a bad flag is a usage error", async () => {
    const run = await cli(["types", "--strict-vars=maybe"], root);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("takes true or false");
    expect((await cli(["types", "--nope"], root)).code).toBe(2);
  });

  test("removes the file earlier releases wrote, and only when it is still as generated", async () => {
    const legacy = join(root, "sproutboat-env.d.ts");
    await writeFile(legacy, `${LEGACY_TYPES_HEADER}\ndeclare global {}\n`);
    expect((await cli(["types"], root)).stdout).toContain("removed sproutboat-env.d.ts");
    expect(existsSync(legacy)).toBe(false);

    await writeFile(legacy, "// my own file\n");
    expect((await cli(["types"], root)).stdout).not.toContain("removed");
    expect(await readFile(legacy, "utf8")).toBe("// my own file\n");
    await rm(legacy);
  });

  test("a project directory as the positional still works", async () => {
    const run = await cli(["types", root], tmpdir());
    expect(run.code).toBe(0);
    expect(existsSync(join(root, "worker-configuration.d.ts"))).toBe(true);
  });
});

describe("the generated types, checked by tsc", () => {
  const tsc = () => run([TSC, "-p", root], root);

  test("a Workers-style handler using every binding typechecks, declarations included", async () => {
    expect((await cli(["types"], root)).code).toBe(0);
    const out = await tsc();
    expect(out.stdout + out.stderr).toBe("");
    expect(out.code).toBe(0);
  }, 60_000);

  test("the mistakes the types exist for are errors", async () => {
    const good = await readFile(join(root, "src/index.ts"), "utf8");
    const bad = (extra: string) =>
      good.replace("    ctx.waitUntil(Promise.resolve());", `    ${extra}\n    ctx.waitUntil(Promise.resolve());`);
    const errors = async (source: string) => {
      await writeFile(join(root, "src/index.ts"), source);
      const out = await tsc();
      expect(out.code).not.toBe(0);
      return out.stdout;
    };
    try {
      // A binding call that is not awaited is a Promise, not a string.
      expect(await errors(bad("const unawaited: string | null = env.KV.get('k');"))).toContain("TS2322");
      // A misspelt binding.
      expect(await errors(bad("await env.KVV.get('k');"))).toContain("TS2339");
      // A method the Durable Object class does not have.
      expect(await errors(bad("await env.COUNTER.getByName('a').nope();"))).toContain("TS2339");
      // A var is a literal type.
      expect(await errors(bad("const other: 'Goodbye' = env.GREETING;"))).toContain("TS2322");
      // Handler arguments are typed: a scheduled controller has no `batch`.
      expect(await errors(good.replace("controller.cron +", "controller.batch +"))).toContain("TS2339");
    } finally {
      await writeFile(join(root, "src/index.ts"), good);
    }
  }, 120_000);
});
