/**
 * `sproutboat run`: launch a standalone binary with the settings it takes at
 * launch (#275), without baking any of them into it.
 *
 * A standalone binary reads its port, data directory and secrets from the
 * environment and nothing from argv. This command builds that environment from
 * three layers and starts the binary with it. Highest precedence first:
 *
 * 1. explicit launch options: `--port` (PORT) and `--data-dir` (SB_DATA_DIR);
 * 2. the files given with `--env-file` (dotenv syntax, see env-file.ts; repeat
 *    the flag and a later file overrides an earlier one);
 * 3. the environment this command inherited, which is how a service manager
 *    hands a production binary its settings.
 *
 * Unlike `dev`, which warns, a launch fails when a declared secret (the
 * config's `secrets` plus any `--require`) is unset or empty, as
 * `wrangler deploy` does for a missing required secret. Nothing starts. The same binary therefore moves between a
 * laptop and a server with a different env file, port and data directory.
 * Nothing is written to disk and no value is ever printed: the summary names
 * secrets and the layer each came from.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseProjectConfig } from "./account-field";
import { locateProject } from "./global-flags";
import {
  mergeEntries,
  MissingSecretsError,
  missingSecrets,
  readEnvFile,
  resolveEnvironment,
  type EnvEntry,
  type EnvSource,
} from "./env-file";

export const RUN_USAGE =
  "run [project-dir] [--binary <file>] [--env-file <file>]... [--port <n>] [--data-dir <dir>] [--require <NAME,...>] [--check]";

const VALUE_FLAGS = ["--binary", "--env-file", "--port", "--data-dir", "--require"] as const;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type RunArgs = {
  dir: string | undefined;
  binary: string | undefined;
  /** Every `--env-file`, in the order given. */
  envFiles: string[];
  port: number | undefined;
  dataDir: string | undefined;
  require: string[];
  check: boolean;
};

/** Parse `run` arguments; `error` is a usage error message. */
export function parseRunArgs(args: string[]): { args: RunArgs } | { error: string } {
  const parsed: RunArgs = {
    dir: undefined,
    binary: undefined,
    envFiles: [],
    port: undefined,
    dataDir: undefined,
    require: [],
    check: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") parsed.check = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      if (!VALUE_FLAGS.some((known) => known === flag)) return { error: `run: unknown flag "${flag}"` };
      const value = eq < 0 ? args[++index] : arg.slice(eq + 1);
      if (value === undefined || (eq < 0 && value.startsWith("--"))) return { error: `run: ${flag} needs a value` };
      if (flag === "--binary") parsed.binary = value;
      else if (flag === "--env-file") parsed.envFiles.push(value);
      else if (flag === "--data-dir") parsed.dataDir = value;
      else if (flag === "--port") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535)
          return { error: `run: --port must be a whole number from 1 to 65535 (got "${value}")` };
        parsed.port = port;
      } else {
        for (const name of value.split(",").map((part) => part.trim())) {
          if (name === "") continue;
          if (!NAME.test(name)) return { error: `run: --require takes variable names (letters, digits, underscore)` };
          parsed.require.push(name);
        }
      }
    } else if (parsed.dir === undefined) parsed.dir = arg;
    else return { error: `run: unexpected argument "${arg}"` };
  }
  return { args: parsed };
}

/** A launch that cannot proceed for a reason the user can fix; the message is safe to print. */
export class RunError extends Error {}

export type RunPlan = {
  binary: string;
  /** The complete environment the binary starts with. Contains secret values: never print it. */
  env: Record<string, string>;
  declared: string[];
  /** Lines naming what was resolved and from where. No values of secrets. */
  summary: string[];
  /** Env-file lines that were skipped, as `file:line: reason`. Never a value. */
  warnings: string[];
};

/** Resolve what to launch and with which environment, or throw. Starts nothing. */
export async function planRun(
  args: RunArgs,
  io: { cwd: string; inherited: Record<string, string | undefined>; config?: string },
): Promise<RunPlan> {
  let located: { directory: string; configPath: string };
  try {
    located = locateProject(args.dir, io.config, io.cwd);
  } catch (error) {
    throw new RunError(error instanceof Error ? error.message : String(error));
  }
  const { directory, configPath } = located;
  let name: string | undefined;
  const declared: string[] = [];
  if (existsSync(configPath)) {
    const parsed = parseProjectConfig(await readFile(configPath, "utf8"));
    if (!parsed.ok) throw new RunError(parsed.errors.join("\n"));
    name = parsed.value.name;
    declared.push(...(parsed.value.secrets ?? []));
  } else if (args.binary === undefined) {
    throw new RunError(
      `no ${io.config === undefined ? "sproutboat.jsonc" : "config file"} found in ${io.config === undefined ? directory : configPath}; pass --binary <file> to run a binary without a project`,
    );
  }
  for (const required of args.require) if (!declared.includes(required)) declared.push(required);

  const binary = args.binary !== undefined ? resolve(io.cwd, args.binary) : resolve(directory, "dist", name ?? "");
  if (!existsSync(binary)) {
    throw new RunError(
      `no binary at ${binary}; build it first with: sproutboat build --standalone${args.dir ? ` ${args.dir}` : ""}`,
    );
  }

  const layers: EnvEntry[][] = [];
  const warnings: string[] = [];
  for (const path of args.envFiles) {
    const parsed = await readEnvFile(resolve(io.cwd, path));
    layers.push(parsed.entries);
    warnings.push(...parsed.warnings);
  }
  const file = mergeEntries(layers);
  const options: Record<string, string> = {};
  if (args.port !== undefined) options.PORT = String(args.port);
  if (args.dataDir !== undefined) options.SB_DATA_DIR = resolve(io.cwd, args.dataDir);
  const { env, sources } = resolveEnvironment({ inherited: io.inherited, file, options });

  const missing = missingSecrets(declared, env);
  if (missing.length > 0) {
    throw new MissingSecretsError(
      missing,
      args.envFiles.length > 0 ? args.envFiles.join(" or ") : "an env file (--env-file)",
    );
  }

  const origin = (key: string): EnvSource | undefined => sources.get(key);
  const summary: string[] = [];
  summary.push(
    declared.length === 0
      ? "secrets   none declared"
      : `secrets   ${declared.map((secret) => `${secret} (${origin(secret) ?? "unset"})`).join(", ")}`,
  );
  if (env.PORT) summary.push(`port      ${env.PORT} (${origin("PORT")})`);
  const dataKey = env.SB_DATA_DIR ? "SB_DATA_DIR" : env.SPROUTBOAT_DATA ? "SPROUTBOAT_DATA" : undefined;
  if (dataKey) summary.push(`data      ${env[dataKey]} (${origin(dataKey)})`);
  return { binary, env, declared, summary, warnings };
}
