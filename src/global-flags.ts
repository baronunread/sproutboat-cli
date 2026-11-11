/**
 * Flags that every command accepts, parsed in one place and removed from argv before a command sees it.
 * Semantics follow Wrangler's global flags:
 *
 *   -c, --config <file>   the project's config file (its directory is the project directory)
 *       --cwd <dir>       run as if started in <dir>
 *   -e, --env <name>      environment: selects .dev.vars.<name> and the .env.<name> files
 *       --env-file <file> repeatable; values from later files override earlier ones
 *       --profile <name>  the credential profile (also SPROUTBOAT_PROFILE)
 *       --api-url <url>   the control plane (also SPROUTBOAT_API_URL); only for commands that talk to one
 *   -v, --version         print the version
 *
 * They can sit anywhere on the line, before or after the command, as `--flag value` or `--flag=value`. A
 * repeated single-value flag takes its last value (a script's fixed flags can be overridden by appending).
 * Everything after a bare `--` is left alone, and so is the value of a flag whose value is free text.
 * `-h/--help` stays in the arguments: the command decides what to print.
 */
import { dirname, resolve } from "node:path";

export type GlobalFlags = {
  config?: string;
  cwd?: string;
  env?: string;
  /** Every `--env-file`, in the order given. */
  envFiles: string[];
  profile?: string;
  /** `--api-url`: taken out here so every command that talks to a control plane honours it, in both forms. */
  apiUrl?: string;
  version: boolean;
};

export type GlobalParse = { flags: GlobalFlags; rest: string[] } | { error: string };

type Spec = { names: readonly string[]; key: "config" | "cwd" | "env" | "envFiles" | "profile" | "apiUrl" };

const VALUE_FLAGS: readonly Spec[] = [
  { names: ["-c", "--config"], key: "config" },
  { names: ["--cwd"], key: "cwd" },
  { names: ["-e", "--env"], key: "env" },
  { names: ["--env-file"], key: "envFiles" },
  { names: ["--profile"], key: "profile" },
  { names: ["--api-url"], key: "apiUrl" },
];

/** Per-command flags whose value is free text: it must never be read as a global flag (`--value -e`). */
const FREE_TEXT_FLAGS = new Set(["--value", "--token", "--search", "--outcome", "--name", "--command"]);

/** Split argv into the global flags and what is left for the command. Does not touch the filesystem. */
export function extractGlobalFlags(argv: readonly string[]): GlobalParse {
  const flags: GlobalFlags = { envFiles: [], version: false };
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === "--") {
      rest.push(...argv.slice(at));
      break;
    }
    if (FREE_TEXT_FLAGS.has(arg)) {
      rest.push(arg);
      if (at + 1 < argv.length) rest.push(argv[(at += 1)]);
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      flags.version = true;
      continue;
    }
    const eq = arg.startsWith("-") ? arg.indexOf("=") : -1;
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const spec = VALUE_FLAGS.find((candidate) => candidate.names.includes(name));
    if (!spec) {
      rest.push(arg);
      continue;
    }
    const value = eq < 0 ? argv[(at += 1)] : arg.slice(eq + 1);
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("-") && value !== "-"))
      return { error: `${name} needs a value` };
    if (spec.key === "envFiles") flags.envFiles.push(value);
    else flags[spec.key] = value;
  }
  return { flags, rest };
}

/** The global flags of this run. Set once by `main.ts` before any command runs. */
let current: GlobalFlags = { envFiles: [], version: false };

export function setGlobalFlags(flags: GlobalFlags): void {
  current = flags;
}

export function globalFlags(): GlobalFlags {
  return current;
}

export type ProjectLocation = { directory: string; configPath: string };

/** What `--config` and a positional project directory say, together. */
export function locateProject(
  positional: string | undefined,
  config: string | undefined = current.config,
  cwd: string = process.cwd(),
): ProjectLocation {
  if (config === undefined) {
    const directory = resolve(cwd, positional ?? ".");
    return { directory, configPath: resolve(directory, "sproutboat.jsonc") };
  }
  const configPath = resolve(cwd, config);
  const directory = dirname(configPath);
  if (positional !== undefined && resolve(cwd, positional) !== directory)
    throw new Error(
      `--config ${config} is in ${directory}, but the project directory says ${resolve(cwd, positional)}; pass one`,
    );
  return { directory, configPath };
}
