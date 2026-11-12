/**
 * The `sproutboat types` command: its arguments, the file it writes, and `--check`.
 *
 * Wrangler's contract (`wrangler types [path]`): the positional is the declaration file to write, default
 * `worker-configuration.d.ts`; `--env-interface`, `--strict-vars`, `--include-runtime`, `--include-env` and `--check`
 * behave as there. Two differences are on purpose and said in the help: `--include-runtime` references the runtime
 * types shipped with the CLI instead of copying them in, and there is no `--include-main-module` (nothing here reads
 * `ctx.exports`).
 *
 * Earlier releases took a project directory as the one positional. A positional that is an existing directory is
 * still read that way.
 */
import { existsSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { SproutboatConfig } from "./config";
import {
  exportedClasses,
  generateTypes,
  hashOf,
  isCurrent,
  LEGACY_TYPES_FILE,
  LEGACY_TYPES_HEADER,
  TYPES_FILE,
  type TypesOptions,
} from "./types-gen";

export const TYPES_USAGE =
  "types [path] [--env-interface <name>] [--no-strict-vars] [--no-include-runtime] [--no-include-env] [--check]";

export type TypesArgs = {
  /** The declaration file, as typed; or the project directory when it names an existing directory. */
  positional?: string;
  options: Omit<TypesOptions, "command" | "mainModule">;
  check: boolean;
};

type BooleanOption = "strictVars" | "includeRuntime" | "includeEnv";
const BOOLEAN_FLAGS = new Map<string, BooleanOption>([
  ["--strict-vars", "strictVars"],
  ["--include-runtime", "includeRuntime"],
  ["--include-env", "includeEnv"],
]);

/** Parse what is left after the global flags and `checkOptions`, where `--flag=value` is already `--flag value`. */
export function parseTypesArgs(args: readonly string[]): TypesArgs | { error: string } {
  const out: TypesArgs = { options: {}, check: false };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--check") out.check = true;
    else if (arg === "--env-interface") {
      const value = args[(at += 1)];
      if (value === undefined || value.startsWith("--")) return { error: "--env-interface needs a name" };
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return { error: `"${value}" is not a valid interface name` };
      out.options.envInterface = value;
    } else if (BOOLEAN_FLAGS.has(arg) || (arg.startsWith("--no-") && BOOLEAN_FLAGS.has(`--${arg.slice(5)}`))) {
      const negated = !BOOLEAN_FLAGS.has(arg);
      const key = BOOLEAN_FLAGS.get(negated ? `--${arg.slice(5)}` : arg)!;
      if (negated) {
        out.options[key] = false;
        continue;
      }
      const next = args[at + 1];
      // `--strict-vars=false` arrives as `--strict-vars false`; a bare `--strict-vars` means true.
      if (next === "true" || next === "false") {
        out.options[key] = next === "true";
        at += 1;
      } else if (next === undefined || next.startsWith("--")) out.options[key] = true;
      else return { error: `${arg} takes true or false, not "${next}"` };
    } else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    else if (out.positional === undefined) out.positional = arg;
    else return { error: `unexpected argument "${arg}"` };
  }
  return out;
}

/** The command line as it is recorded in the generated file's header: the flags that differ from the defaults. */
function commandLine(parsed: TypesArgs, path: string | undefined): string {
  const { envInterface, strictVars, includeRuntime, includeEnv } = parsed.options;
  return [
    "sproutboat types",
    ...(path ? [path] : []),
    ...(envInterface && envInterface !== "Env" ? [`--env-interface=${envInterface}`] : []),
    ...(strictVars === false ? ["--strict-vars=false"] : []),
    ...(includeRuntime === false ? ["--include-runtime=false"] : []),
    ...(includeEnv === false ? ["--include-env=false"] : []),
  ].join(" ");
}

export type TypesPlan = {
  /** Absolute path of the declaration file. */
  path: string;
  /** What `generateTypes` writes for it. */
  text: string;
  /** The positional was a project directory, which this release still reads (the file is then the default one). */
  legacyDirectory: boolean;
};

/**
 * The project directory and output file for a positional, and the file's text.
 *
 * `projectDirectory` is where `sproutboat.jsonc` is (already resolved from `-c` / `--cwd` and a directory
 * positional); the output path is relative to the working directory, as in Wrangler.
 */
export async function planTypes(
  parsed: TypesArgs,
  config: SproutboatConfig,
  projectDirectory: string,
  cwd: string = process.cwd(),
): Promise<TypesPlan> {
  const positional = parsed.positional;
  const asDirectory = positional !== undefined && isDirectory(resolve(cwd, positional));
  const path =
    positional === undefined || asDirectory ? resolve(projectDirectory, TYPES_FILE) : resolve(cwd, positional);

  let mainModule: TypesOptions["mainModule"];
  if (/\.(?:ts|mts|tsx)$/.test(config.main)) {
    const entry = resolve(projectDirectory, config.main);
    try {
      const classes = exportedClasses(await readFile(entry, "utf8"));
      if (classes.length) {
        const rel = relative(dirname(path), entry.replace(/\.[^./\\]+$/, ""))
          .split(sep)
          .join("/");
        mainModule = { importPath: rel.startsWith(".") ? rel : `./${rel}`, classes };
      }
    } catch {
      // No entry file yet: the bindings are still worth typing.
    }
  }
  const text = generateTypes(config, {
    ...parsed.options,
    mainModule,
    command: commandLine(parsed, positional !== undefined && !asDirectory ? positional : undefined),
  });
  return { path, text, legacyDirectory: asDirectory };
}

/** `--check`: whether the file at `path` is the one `plan` would write. Missing or hand-written is not current. */
export async function checkTypes(plan: TypesPlan): Promise<"current" | "stale" | "missing"> {
  if (!existsSync(plan.path)) return "missing";
  return isCurrent(await readFile(plan.path, "utf8"), plan.text) ? "current" : "stale";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Remove the file earlier releases wrote, when it is still exactly what they generated. */
export async function removeLegacyTypes(projectDir: string): Promise<boolean> {
  const legacy = resolve(projectDir, LEGACY_TYPES_FILE);
  try {
    if (!(await readFile(legacy, "utf8")).startsWith(LEGACY_TYPES_HEADER)) return false;
    await rm(legacy);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite the generated types when the config has moved on, and only when the default file is the one a plain
 * `sproutboat types` wrote. Called from `dev` and `deploy` so a binding added to sproutboat.jsonc cannot sit
 * unreflected in the editor. It writes only when the content differs, which keeps it out of the way of git and of
 * file watchers, and leaves a file made with other flags (or by hand) alone: Wrangler never touches it either.
 * Returns what it did, for the caller to print.
 */
export async function refreshTypes(
  projectDir: string,
  config: SproutboatConfig,
): Promise<{ wrote: boolean; removedLegacy: boolean }> {
  const parsed = parseTypesArgs([]);
  if ("error" in parsed) return { wrote: false, removedLegacy: false };
  const plan = await planTypes(parsed, config, projectDir, projectDir);
  let have: string | undefined;
  try {
    have = await readFile(plan.path, "utf8");
  } catch {
    // No file yet: only write one if the project already opted in with a tsconfig. A plain JavaScript project gets none.
    if (!existsSync(resolve(projectDir, "tsconfig.json"))) return { wrote: false, removedLegacy: false };
  }
  if (have !== undefined) {
    const customCommand = !(have.split("\n", 2)[1] ?? "").includes("`sproutboat types`");
    if (hashOf(have) === undefined || customCommand || hashOf(have) === hashOf(plan.text))
      return { wrote: false, removedLegacy: false };
  }
  await writeFile(plan.path, plan.text);
  return { wrote: true, removedLegacy: await removeLegacyTypes(projectDir) };
}
