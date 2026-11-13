/**
 * Helpers for running an example under workerd (`wrangler dev`) and for typechecking it against Cloudflare's own
 * runtime types. Used by `examples/workerd.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseConfig } from "../../../src/config";
import { toWranglerConfig, type WranglerConfig } from "./wrangler-config";
import { descendantPids } from "./harness";
import { projectDir, REPO } from "./projects";

export const WRANGLER = join(REPO, "node_modules/.bin/wrangler");
export const WORKERD = join(REPO, "node_modules/.bin/workerd");
export const TSC = join(REPO, "node_modules/.bin/tsc");

/** The newest compatibility date the installed workerd knows (`workerd 2026-11-10`). */
export function workerdCompatibilityDate(): string {
  const result = Bun.spawnSync([WORKERD, "--version"]);
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(result.stdout.toString())?.[1];
  if (!date) throw new Error(`cannot read the date from \`workerd --version\`: ${result.stdout.toString()}`);
  return date;
}

export function readConfig(example: string) {
  const path = join(projectDir(example), "sproutboat.jsonc");
  const parsed = parseConfig(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new Error(`${example}: ${parsed.errors.join("; ")}`);
  return { config: parsed.value, path };
}

/** Write `<dir>/wrangler.jsonc` (and `.dev.vars` for secrets) for `example`; returns the config's path. */
export function writeWranglerProject(
  example: string,
  dir: string,
  maxDate: string,
  secrets: Record<string, string> = {},
): string {
  const { config, path } = readConfig(example);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "wrangler.jsonc");
  const wrangler = toWranglerConfig(config, path, maxDate);
  // A project with a migrations/ folder says so, as Wrangler expects (its default folder is relative to the config).
  const migrations = join(dirname(path), "migrations");
  if (existsSync(migrations)) for (const database of wrangler.d1_databases ?? []) database.migrations_dir = migrations;
  writeFileSync(target, JSON.stringify(wrangler, null, 2));
  const names = config.secrets ?? [];
  const lines = names.map((name) => {
    const value = secrets[name];
    if (value === undefined) throw new Error(`${example}: secret ${name} has no test value in checks.ts SECRETS`);
    return `${name}=${value}`;
  });
  if (lines.length) writeFileSync(join(dir, ".dev.vars"), lines.join("\n") + "\n");
  return target;
}

/**
 * `wrangler d1 migrations apply --local` for every database of the config that has a migrations folder, into the same
 * state directory `wrangler dev --persist-to` will read. Returns wrangler's output when one fails, empty when all pass.
 */
export async function applyWranglerMigrations(config: string, cwd: string, state: string): Promise<string> {
  // SAFETY: the file is the JSON writeWranglerProject wrote a moment ago, in WranglerConfig's shape.
  const written = JSON.parse(readFileSync(config, "utf8")) as WranglerConfig;
  for (const database of written.d1_databases ?? []) {
    if (!database.migrations_dir) continue;
    const child = Bun.spawn(
      [WRANGLER, "d1", "migrations", "apply", database.database_name, "--local", "--persist-to", state, "-c", config],
      { cwd, env: wranglerEnv(cwd), stdout: "pipe", stderr: "pipe", timeout: 120_000, killSignal: "SIGKILL" },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) return `wrangler d1 migrations apply ${database.database_name} failed:\n${out}${err}`;
  }
  return "";
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stop `pid` and everything it started. `wrangler dev` forks a process tree (its own workers and workerd), and
 * stopping only the parent leaves those running, reparented to init. So the tree is read first, while it is still
 * attached, and every recorded pid is stopped: politely, then for good. Only pids found under `pid`, never by name.
 */
export async function stopTree(pid: number): Promise<void> {
  const tree = [pid, ...descendantPids(pid)];
  for (const member of tree) {
    try {
      process.kill(member, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && tree.some(alive)) await Bun.sleep(100);
  for (const member of tree) {
    if (!alive(member)) continue;
    try {
      process.kill(member, "SIGKILL");
    } catch {}
  }
}

/** The environment for wrangler: nothing written outside `dir`, no telemetry, no prompts. */
export function wranglerEnv(dir: string) {
  return {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(dir, "logs"),
    XDG_CONFIG_HOME: join(dir, "xdg"),
    CLOUDFLARE_API_TOKEN: undefined,
    CLOUDFLARE_ACCOUNT_ID: undefined,
  };
}

/**
 * Typecheck the example's entry against Cloudflare's runtime types, which is what `wrangler types` generates from the
 * same bindings: no Sproutboat declaration is in this program, so an API only Sproutboat has is an error.
 * Returns tsc's output, empty when it passes.
 */
export async function typecheckAgainstCloudflare(
  example: string,
  dir: string,
  wranglerConfig: string,
): Promise<string> {
  const { config, path } = readConfig(example);
  const types = join(dir, "cf-types");
  mkdirSync(types, { recursive: true });
  const generate = Bun.spawn([WRANGLER, "types", join(types, "worker-configuration.d.ts"), "-c", wranglerConfig], {
    cwd: dir,
    env: wranglerEnv(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(generate.stdout).text(),
    new Response(generate.stderr).text(),
    generate.exited,
  ]);
  if (code !== 0) return `wrangler types failed:\n${out}${err}`;
  writeFileSync(
    join(types, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022"],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        isolatedModules: true,
        // wrangler and esbuild both resolve "./room.ts", so a starter may spell its imports that way.
        allowImportingTsExtensions: true,
      },
      files: [resolve(join(path, ".."), config.main), join(types, "worker-configuration.d.ts")],
    }),
  );
  const tsc = Bun.spawn([TSC, "-p", types], { cwd: types, stdout: "pipe", stderr: "pipe" });
  const [tscOut, tscErr] = await Promise.all([new Response(tsc.stdout).text(), new Response(tsc.stderr).text()]);
  await tsc.exited;
  return (tscOut + tscErr).trim();
}
