/**
 * Local secret input (#275), modelled on Wrangler so the habits carry over.
 *
 * `sproutboat dev` takes local secrets from files, never from the process
 * environment unless asked:
 *
 * - `.dev.vars` beside the config, or the `.env` files, never both. When a
 *   `.dev.vars` exists the `.env*` files are not loaded (a warning names them).
 *   With `--env <name>`, `.dev.vars.<name>` replaces `.dev.vars` when it exists.
 * - The `.env` files layer, most specific first: `.env.<name>.local`,
 *   `.env.local`, `.env.<name>`, `.env`. `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`
 *   turns this off. Repeated `--env-file` flags replace the default set; a later
 *   file overrides an earlier one.
 * - The process environment reaches the app only when
 *   `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` and no `.dev.vars` is in use, and then
 *   only for declared secret names. Files win over it.
 * - A declared secret with no value is a warning, and `dev` still starts.
 *
 * `sproutboat run` (the production launch of a standalone binary) is stricter:
 * a missing declared secret fails, like `wrangler deploy`. Its layers, highest
 * first: `--port` and `--data-dir`, the `--env-file` files (later overrides
 * earlier), the inherited environment.
 *
 * File syntax is dotenv's: `NAME=value`, an optional `export `, `#` comments
 * (a whole line, or after an unquoted value), single, double and backtick quotes,
 * `\n` and `\r` expanded inside double quotes only, quoted values may span lines,
 * the last of a repeated name wins. A line that is not an assignment is skipped
 * with a `file:line` warning. Warnings never repeat the text of a line, so a value
 * cannot leak through one.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type EnvEntry = { key: string; value: string; line: number };
export type EnvSource = "option" | "env file" | "environment";
export type ParsedEnv = { entries: EnvEntry[]; warnings: string[] };

/** A file that could not be read at all (a missing explicit file). The message is safe to print. */
export class EnvFileError extends Error {}

/** Declared secrets that are unset or empty, for a launch that must not start without them. Names only. */
export class MissingSecretsError extends Error {
  constructor(
    readonly names: string[],
    where: string,
  ) {
    super(
      `missing declared secret${names.length === 1 ? "" : "s"}: ${names.join(", ")}. Set ${names.length === 1 ? "it" : "them"} in ${where} or in the environment.`,
    );
  }
}

const ASSIGNMENT = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*|:\s+)(.*)$/;

/** Parse dotenv text. Never throws: a bad line becomes a warning. */
export function parseDotenv(text: string, label: string): ParsedEnv {
  const source = (text.startsWith("﻿") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const byKey = new Map<string, EnvEntry>();
  const warnings: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) {
      warnings.push(`${label}:${index + 1}: skipped, not a NAME=value assignment`);
      continue;
    }
    const key = match[1];
    const rest = match[2].trimStart();
    const quote = rest[0];
    let value: string;
    if (quote === "'" || quote === '"' || quote === "`") {
      let out = "";
      let row = index;
      let column = 0;
      let current = rest.slice(1);
      let closed = false;
      for (;;) {
        while (column < current.length) {
          const char = current[column];
          // As in dotenv, an escaped closing quote does not end the value (and the backslash stays).
          if (char === "\\" && current[column + 1] === quote) {
            out += char + quote;
            column += 2;
            continue;
          }
          if (char === quote) {
            closed = true;
            break;
          }
          out += char;
          column += 1;
        }
        if (closed || row + 1 >= lines.length) break;
        row += 1;
        current = lines[row];
        column = 0;
        out += "\n";
      }
      if (!closed) {
        warnings.push(`${label}:${index + 1}: skipped, unterminated ${quote} quote`);
        break;
      }
      index = row;
      value = quote === '"' ? out.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : out;
    } else {
      const hash = rest.indexOf("#");
      value = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
    }
    byKey.set(key, { key, value, line: index + 1 });
  }
  return { entries: [...byKey.values()], warnings };
}

/** Read and parse an env file. Throws EnvFileError when it cannot be read. */
export async function readEnvFile(path: string): Promise<ParsedEnv> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") throw new EnvFileError(`env file not found: ${path}`);
    throw new EnvFileError(`could not read ${path}: ${code ?? "unknown error"}`);
  }
  return parseDotenv(text, path);
}

/** Later entries override earlier ones, by name. */
export function mergeEntries(layers: EnvEntry[][]): EnvEntry[] {
  const merged = new Map<string, EnvEntry>();
  for (const layer of layers) for (const entry of layer) merged.set(entry.key, entry);
  return [...merged.values()];
}

export type EnvInput = {
  inherited: Record<string, string | undefined>;
  file?: EnvEntry[];
  /** Explicit launch options as environment variables: `--port` is PORT, `--data-dir` is SB_DATA_DIR. */
  options?: Record<string, string>;
};
export type ResolvedEnvironment = { env: Record<string, string>; sources: Map<string, EnvSource> };

/** The environment to launch with, and which layer each name came from. Values are never logged. */
export function resolveEnvironment(input: EnvInput): ResolvedEnvironment {
  const env: Record<string, string> = {};
  const sources = new Map<string, EnvSource>();
  for (const [key, value] of Object.entries(input.inherited)) {
    if (value === undefined) continue;
    env[key] = value;
    sources.set(key, "environment");
  }
  for (const entry of input.file ?? []) {
    env[entry.key] = entry.value;
    sources.set(entry.key, "env file");
  }
  for (const [key, value] of Object.entries(input.options ?? {})) {
    env[key] = value;
    sources.set(key, "option");
  }
  return { env, sources };
}

/** Declared secrets that are unset or empty in `env`, in declaration order. */
export function missingSecrets(declared: readonly string[], env: Record<string, string>): string[] {
  return declared.filter((name) => (env[name] ?? "") === "");
}

export type DevVars = {
  /** What the app sees: every name from the files, plus declared names the process environment supplies when allowed. */
  values: Record<string, string>;
  /** Files that were read, in order of increasing precedence. */
  used: string[];
  /** Everything worth telling the developer: ignored files, skipped lines, missing declared secrets. No values. */
  warnings: string[];
};

/** Local secrets for `sproutboat dev`, by the rules in the module comment. */
export async function resolveDevVars(input: {
  projectDir: string;
  /** `--env <name>`: selects `.dev.vars.<name>` and the `.env.<name>` files. */
  envName?: string;
  /** `--env-file` paths, absolute, in the order given. */
  envFiles?: string[];
  declared: readonly string[];
  inherited: Record<string, string | undefined>;
}): Promise<DevVars> {
  const warnings: string[] = [];
  const at = (name: string) => resolve(input.projectDir, name);
  const name = input.envName;
  const explicit = input.envFiles ?? [];
  const devVarsPath = [name ? at(`.dev.vars.${name}`) : undefined, at(".dev.vars")].find(
    (path) => path !== undefined && existsSync(path),
  );
  const loadDotEnv = input.inherited.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV !== "false";
  const dotEnvCandidates =
    explicit.length > 0
      ? explicit
      : [
          at(".env"),
          ...(name ? [at(`.env.${name}`)] : []),
          at(".env.local"),
          ...(name ? [at(`.env.${name}.local`)] : []),
        ];

  let layers: EnvEntry[][] = [];
  const used: string[] = [];
  if (devVarsPath !== undefined) {
    const present = dotEnvCandidates.filter((path) => existsSync(path));
    if (present.length > 0)
      warnings.push(`${devVarsPath} exists, so the .env files are not loaded (ignored: ${present.join(", ")})`);
    const parsed = await readEnvFile(devVarsPath);
    warnings.push(...parsed.warnings);
    layers = [parsed.entries];
    used.push(devVarsPath);
  } else if (!loadDotEnv) {
    if (explicit.length > 0)
      warnings.push("CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false, so the --env-file files are not loaded");
  } else {
    for (const path of dotEnvCandidates) {
      // The default files are optional; a file named with --env-file is not.
      if (explicit.length === 0 && !existsSync(path)) continue;
      const parsed = await readEnvFile(path);
      warnings.push(...parsed.warnings);
      layers.push(parsed.entries);
      used.push(path);
    }
  }

  const values: Record<string, string> = {};
  for (const entry of mergeEntries(layers)) values[entry.key] = entry.value;
  // The process environment never reaches the app by default, and not when .dev.vars is in use.
  if (devVarsPath === undefined && input.inherited.CLOUDFLARE_INCLUDE_PROCESS_ENV === "true") {
    for (const declaredName of input.declared) {
      const fromProcess = input.inherited[declaredName];
      if (values[declaredName] === undefined && fromProcess !== undefined) values[declaredName] = fromProcess;
    }
  }
  const missing = input.declared.filter((declaredName) => (values[declaredName] ?? "") === "");
  if (missing.length > 0) {
    warnings.push(
      `declared secret${missing.length === 1 ? "" : "s"} with no value: ${missing.join(", ")}. A handler that reads ${missing.length === 1 ? "it" : "one"} will throw. Set ${missing.length === 1 ? "it" : "them"} in .dev.vars or a .env file.`,
    );
  }
  return { values, used, warnings };
}
