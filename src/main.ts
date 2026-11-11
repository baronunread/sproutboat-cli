#!/usr/bin/env bun
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isBoolean, isSafeInteger, isString, jsonObject, parseJsonValue, type JsonObject } from "./json";
import type { AssetFiles } from "./assets";
import { pinBindingId, resourceRefs, type SproutboatConfig } from "./config";
import { validateHttpSyncSource } from "./source";
import { buildArtifact, emitGenerated } from "./build";
import { generateTypes, TYPES_FILE } from "./types-gen";
import { bundleHandler, BundleError, type BundleResult } from "./bundle";
import { runDev } from "./dev";
import { buildStandalone, emitStandalone, isReleaseBuild } from "./standalone-build";
import { hostTarget, validateManifest, type ArtifactManifest } from "./manifest";
import { CLI_VERSION, printDeployReport } from "./report";
import {
  activeProfileName,
  forgetToken,
  listProfiles,
  PROFILE_NAME,
  savedProfile,
  savedProfileName,
  savedToken,
  saveToken,
  selectProfile,
  useProfile,
} from "./credentials";
import { extractGlobalFlags, globalFlags, locateProject, setGlobalFlags } from "./global-flags";
import { checkOptions, ENDPOINT_COMMANDS } from "./options";
import { chooseTarget, TargetError, type Target } from "./target";
import { configAccount, configMigrationsDir, parseProjectConfig } from "./account-field";
import { DATA_ERROR_STATUSES } from "./data-errors";
import {
  cloudLogout,
  CloudError,
  DEFAULT_API_URL,
  detectKind,
  parseBody,
  envToken,
  fetchWhoami,
  loginAndStore,
  resolveSession,
  storeGivenKey,
  type CloudIo,
} from "./cloud";
import {
  buildAndDeploy,
  buildAssetBundle,
  checkServiceBindings,
  CLOUD_PROJECT_RE,
  compileModule,
  deployToCloud,
  formatKiB,
  hostFor,
  Interrupted,
  makeCall,
} from "./cloud-deploy";
import {
  APPLY_USAGE,
  applyMigrations,
  CREATE_USAGE,
  createMigration,
  D1UsageError,
  DEFAULT_MIGRATIONS_DIR,
  EXECUTE_USAGE,
  executeSql,
  LIST_USAGE,
  listMigrations,
  localDatabasePath,
  localRunner,
  parseD1Flags,
  pickBinding,
  remoteRunner,
  type D1Io,
  type Runner,
} from "./d1-cli";
import { deleteCloudSecret, listCloudSecrets, putCloudSecret, readSecretsFile } from "./cloud-secrets";
import { hostname as osHostname, platform as osPlatform, arch as osArch } from "node:os";
import { CLI_NAME, COMMANDS, helpText, STORAGE_PRODUCTS, STORAGE_VERBS, type StorageProduct } from "./surface";
import { notifyIfOutdated } from "./update-check";
import { controlVersionWarning } from "./api-version";
import { amber, bold, dim, leaf, ok, rose } from "./style";
import { detectPackageManager, installCommand, planPackageJson, runScriptCommand } from "./init-package";
import { pathToFileURL } from "node:url";
import { constants as osConstants } from "node:os";
import { inspectToolchain } from "./toolchain";
import { isLinuxTarget, parseTarget, TARGET_NAMES, type BuildTarget } from "./targets";
import { writeDeployFiles } from "./standalone-deploy";
import { parseTailArgs, runTail, TAIL_USAGE, tailQuery, type TailArgs } from "./tail";
import { followLog, LogFilter, readLogStream } from "./tail-log";
import { EnvFileError, MissingSecretsError } from "./env-file";
import { parseRunArgs, planRun, RUN_USAGE, RunError } from "./run";

// A compiled Bun executable is not a general-purpose `bun` command. Porffor
// is acquired after installation, so run its external ESM launcher through an
// explicit private mode inside the packaged runtime.
const internalModeAt = process.argv.slice(1, 3).indexOf("__porffor") + 1;
if (internalModeAt > 0) {
  const launcher = process.argv[internalModeAt + 1];
  if (!launcher) throw new Error("internal Porffor mode requires a launcher path");
  process.argv.splice(1, internalModeAt + 1, launcher);
  await import(pathToFileURL(launcher).href);
  process.exit(0);
}

const defaultApiUrl = DEFAULT_API_URL;

/**
 * baronunread/sproutboat#204 — the single place the endpoint and the stored profile are chosen. `chooseTarget`
 * (target.ts) holds the precedence: the flags, then the environment, then the machine's active profile, then the
 * default endpoint, and a profile and a URL that name different places are an error. The choice is also what the
 * credential lookups use for the rest of the run.
 */
async function resolveApiUrl(
  explicitApiUrl?: string,
  options: { allowNewProfile?: boolean } = {},
): Promise<{ apiUrl: string; source: string; target: Target }> {
  const profiles: Record<string, { apiUrl: string }> = {};
  for (const { name, profile } of await listProfiles()) profiles[name] = { apiUrl: profile.apiUrl };
  let target: Target;
  try {
    target = chooseTarget({
      flagUrl: explicitApiUrl ?? globalFlags().apiUrl,
      flagProfile: globalFlags().profile,
      envUrl: process.env.SPROUTBOAT_API_URL || undefined,
      envProfile: process.env.SPROUTBOAT_PROFILE || undefined,
      profiles,
      activeProfile: await activeProfileName(),
      defaultUrl: defaultApiUrl,
      allowNew: options.allowNewProfile,
    });
  } catch (error) {
    if (error instanceof TargetError) fail(error.message);
    throw error;
  }
  selectProfile(target.profile?.name);
  return { apiUrl: target.apiUrl, source: target.source, target };
}

/** The two lines that say where a command is about to act: which profile, and which endpoint. */
async function printTarget(target: Target): Promise<void> {
  const profile = target.profile;
  const name = profile?.name ?? (await savedProfileName(target.apiUrl));
  const why = profile
    ? `${profile.source}${profile.exists ? "" : ", new"}`
    : name
      ? "the stored login for this endpoint"
      : "nothing stored for this endpoint";
  const credential = envToken();
  console.log(
    `profile   ${name ?? "-"}  ${dim(`(${why}${credential ? `; the credential comes from ${credential.source}` : ""})`)}`,
  );
  const sourceLabel =
    target.source === "profile" ? `profile ${profile?.name}` : target.source === "default" ? "default" : target.source;
  console.log(`endpoint  ${target.apiUrl}  ${dim(`(${sourceLabel})`)}`);
}

/** Warn at most once per run: every API response carries the headers, and one
 *  command makes several calls. */
let skewWarned = false;

async function responseText(response: Response, failure: string): Promise<string> {
  // Checked here rather than at each call site: every control-plane response
  // funnels through this helper, including the failures — and a version-skew
  // 400 is exactly when the user most needs to be told which side is old.
  if (!skewWarned) {
    const warning = controlVersionWarning(response, CLI_VERSION);
    if (warning) {
      skewWarned = true;
      console.warn(amber(`! ${warning}`));
    }
  }
  if (response.ok) return response.text();
  fail(`${failure} (${response.status}): ${await response.text()}`);
}

type VersionSummary = { id: string; artifact: string; deployedAt: string; active: boolean };
type CliAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: string;
};

function parseVersionList(source: string): VersionSummary[] | undefined {
  const value = parseJsonValue(source);
  if (!Array.isArray(value)) return undefined;
  const deployments: VersionSummary[] = [];
  for (const item of value) {
    const record = jsonObject(item);
    if (
      !record ||
      !isString(record.id) ||
      !isString(record.artifact) ||
      !isString(record.deployedAt) ||
      (record.active !== true && record.active !== false)
    )
      return undefined;
    deployments.push({
      id: record.id,
      artifact: record.artifact,
      deployedAt: record.deployedAt,
      active: record.active,
    });
  }
  return deployments;
}

function parseUrlResponse(
  source: string,
): { url: string; id?: string; artifact?: string; unchanged: boolean } | undefined {
  const record = jsonObject(parseJsonValue(source));
  if (!record || !isString(record.url)) return undefined;
  return {
    url: record.url,
    id: isString(record.id) ? record.id : undefined,
    artifact: isString(record.artifact) ? record.artifact : undefined,
    unchanged: record.unchanged === true,
  };
}

/** #55: `{ from, to }` when this deploy moves the live version onto a different
 *  Porffor pin. Deployed artifacts are frozen at their build-time compiler, so
 *  the pin only changes by redeploying — and the alpha compiler's output can
 *  differ between pins. */
function parsePorfforDrift(source: string): { from: string; to: string } | undefined {
  const drift = (() => {
    try {
      return jsonObject(parseJsonValue(source))?.porfforDrift;
    } catch {
      return undefined;
    }
  })();
  const record = drift && jsonObject(drift);
  return record && isString(record.from) && isString(record.to) ? { from: record.from, to: record.to } : undefined;
}

function parseAuthorization(source: string): CliAuthorization | undefined {
  const record = jsonObject(parseJsonValue(source));
  if (
    !record ||
    !isString(record.deviceCode) ||
    !isString(record.userCode) ||
    !isString(record.verificationUri) ||
    !isSafeInteger(record.interval) ||
    !isString(record.expiresAt)
  )
    return undefined;
  return {
    deviceCode: record.deviceCode,
    userCode: record.userCode,
    verificationUri: record.verificationUri,
    interval: record.interval,
    expiresAt: record.expiresAt,
  };
}

function parseToken(source: string): string | undefined {
  const record = jsonObject(parseJsonValue(source));
  return record && isString(record.token) ? record.token : undefined;
}

const starterConfig = (name: string) => `{
  "$schema": "https://sproutboat.com/schema.json",
  "name": "${name}",
  "main": "src/index.js",
  "compatibility_date": "2026-09-28"
}
`;
const starterHandler = `export default {
  fetch(request, env, ctx) {
    return new Response("hello from Sproutboat");
  }
};
`;
// .sproutboat/ holds build output (dist/) and `dev`'s local broker state
// (dev/, including its SQLite files) — neither belongs in version control.
// .dev.vars carries secret values for `sproutboat dev`, same convention as
// Wrangler's file of the same name.
const starterGitignore = `.sproutboat/
.dev.vars
node_modules/
`;

/** An operational failure — the command was invoked correctly but could not complete. Exit 1. */
function fail(message: string): never {
  console.error(`${rose("✗")} ${message}`);
  process.exit(1);
}

/**
 * The command was invoked wrong (missing/unknown arg). Exit 2, the getopt/argparse
 * convention, so scripts can tell "you typed it wrong" apart from "it broke".
 * `usage` is the grammar line without the `usage: ` prefix.
 */
function usageError(what: string, usage: string): never {
  console.error(`${rose("✗")} ${what}\n  ${dim(`usage: sproutboat ${usage}`)}`);
  process.exit(2);
}

/** The project directory and config file, from a positional directory and `--config`. */
function locate(directory?: string) {
  try {
    return locateProject(directory);
  } catch (error) {
    if (error instanceof Error) return fail(error.message);
    throw error;
  }
}

/** Read the project identity and configuration without touching application code.
 * Management commands must remain usable when a local checkout is incomplete. */
async function readProjectConfig(directory?: string) {
  const { directory: projectDirectory, configPath } = locate(directory);
  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf8");
  } catch {
    fail(
      globalFlags().config === undefined
        ? `no sproutboat.jsonc found in ${projectDirectory}`
        : `no config file at ${configPath}`,
    );
  }
  const parsed = parseProjectConfig(configSource);
  if (!parsed.ok) fail(parsed.errors.join("\n"));
  for (const warning of parsed.warnings) console.warn(amber(`! ${warning}`));
  return {
    directory: projectDirectory,
    config: parsed.value,
    account: configAccount(configSource),
    migrationsDir: configMigrationsDir(configSource),
  };
}

/** Full build input: configuration plus entry point, resolved imports and checks. */
async function readProject(directory?: string) {
  const project = await readProjectConfig(directory);
  const sourcePath = resolve(project.directory, project.config.main);
  let source: string;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch {
    fail(`entry point not found: ${project.config.main}`);
  }
  // #89 — resolve imports first, then hold the *bundled* module to the
  // capability rules. Validating the entry file instead would let a dependency
  // smuggle in a Node API the handler is not allowed to touch.
  let bundle: BundleResult;
  try {
    bundle = await bundleHandler(sourcePath, project.directory, {
      compatibilityDate: project.config.compatibility_date,
    });
  } catch (cause) {
    fail(cause instanceof BundleError ? cause.message : String(cause));
  }
  const supported = validateHttpSyncSource(bundle.code, project.config.compatibility_date);
  if (!supported.ok) fail(supported.errors.join("\n"));
  return { ...project, sourcePath, source, bundle };
}

async function init(name = "hello") {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(name))
    fail("project name must be a 3–32 character lowercase slug");
  const directory = resolve(process.cwd(), name);
  const configPath = resolve(directory, "sproutboat.jsonc");
  const handlerPath = resolve(directory, "src/index.js");
  // Check both targets before writing either — `name` can collide with an
  // unrelated existing directory, and a second `wx` write failing partway
  // through used to crash with a raw EEXIST stack trace after already having
  // created sproutboat.jsonc, leaving a half-scaffolded project behind.
  for (const [path, label] of [
    [configPath, "sproutboat.jsonc"],
    [handlerPath, "src/index.js"],
  ] as const) {
    if (await Bun.file(path).exists()) fail(`${basename(directory)} already contains ${label}`);
  }
  // Plan package.json before writing anything, so an unreadable one stops init
  // instead of leaving a half-scaffolded project.
  const packagePath = resolve(directory, "package.json");
  let existingPackage: string | undefined;
  try {
    existingPackage = await readFile(packagePath, "utf8");
  } catch {
    existingPackage = undefined;
  }
  let packagePlan: ReturnType<typeof planPackageJson>;
  try {
    packagePlan = planPackageJson(name, existingPackage, CLI_VERSION);
  } catch (cause) {
    fail(`${basename(directory)}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  await mkdir(resolve(directory, "src"), { recursive: true });
  await writeFile(configPath, starterConfig(name), { flag: "wx" });
  await writeFile(handlerPath, starterHandler, { flag: "wx" });
  console.log(`Created ${basename(directory)}/sproutboat.jsonc`);
  console.log(`Created ${basename(directory)}/src/index.js`);
  // Unlike the two files above, an existing .gitignore here is not a sign this
  // isn't a fresh project (`name` can collide with an unrelated directory) —
  // leave it alone rather than failing init or clobbering it.
  const gitignorePath = resolve(directory, ".gitignore");
  if (!(await Bun.file(gitignorePath).exists())) {
    await writeFile(gitignorePath, starterGitignore, { flag: "wx" });
    console.log(`Created ${basename(directory)}/.gitignore`);
  }
  if (packagePlan.created || packagePlan.addedDependency || packagePlan.addedScripts.length > 0) {
    await writeFile(packagePath, packagePlan.text);
    console.log(`${packagePlan.created ? "Created" : "Updated"} ${basename(directory)}/package.json`);
  }
  for (const script of packagePlan.skippedScripts)
    console.log(
      amber(
        `  ! package.json already has a "${script}" script; left it as is (sproutboat's would be "sproutboat ${script}")`,
      ),
    );
  const manager = detectPackageManager(directory);
  console.log(`\nNext: cd ${basename(directory)} && ${installCommand(manager)} && ${runScriptCommand(manager, "dev")}`);
  console.log(dim(`After "sproutboat login", ship it with ${runScriptCommand(manager, "deploy")}.`));
}

async function check(directory?: string) {
  const project = await readProject(directory);
  console.log(ok(`check passed — ${project.config.name} (${project.config.main}, native-fetch)`));
}

async function types(directory?: string) {
  const project = await readProject(directory);
  const path = resolve(project.directory, TYPES_FILE);
  await writeFile(path, generateTypes(project.config));
  console.log(ok(`wrote ${relative(process.cwd(), path) || TYPES_FILE}`));
  console.log(dim("  Commit it. Add it to tsconfig `include` if your project has one."));
}

/**
 * Rewrite the generated types when the config has moved on, and only then.
 *
 * Called from `dev` and `deploy` so a binding added to sproutboat.jsonc cannot
 * sit unreflected in the editor. It writes only when the content actually
 * differs, which keeps it out of the way of git and of file watchers.
 */
async function refreshTypes(projectDir: string, config: SproutboatConfig): Promise<void> {
  const path = resolve(projectDir, TYPES_FILE);
  const wanted = generateTypes(config);
  try {
    if ((await readFile(path, "utf8")) === wanted) return;
  } catch {
    // No file yet: only write one if the project already opted in by having a
    // tsconfig. Generating into a plain JavaScript project is noise.
    if (!(await Bun.file(resolve(projectDir, "tsconfig.json")).exists())) return;
  }
  await writeFile(path, wanted);
  console.log(dim(`  ${TYPES_FILE} refreshed from sproutboat.jsonc`));
}

async function build(directory?: string, target: BuildTarget = "linux-x86_64") {
  const project = await readProject(directory);
  console.log(
    target === "host"
      ? dim(`Compiling the native-fetch server with Porffor for this machine (${hostTarget()}, local only)…`)
      : dim("Compiling the native-fetch server with Porffor + Zig (linux-x86_64, static)…"),
  );
  const artifact = await buildArtifact({
    projectDir: project.directory,
    config: project.config,
    sourcePath: project.sourcePath,
    source: project.bundle.code,
    target,
  });
  console.log(ok(`built ${project.config.name}`));
  console.log(dim(`  compile  ${artifact.compileMs} ms · binary cache ${artifact.compileCache}`));
  if (target === "host")
    console.log(dim("  host build — runs here, not deployable; drop --target host to build for a box"));
  console.log(artifact.artifactDir);
  return { project, artifact };
}

/**
 * #15 — one executable carrying the sprout, its assets and its bindings.
 *
 * Defaults to a host build: the point is a binary you can run right here. Pass
 * `--target linux-x86_64` for a box, but note the Bun launcher is compiled for
 * *this* machine either way in phase 0 — cross-compiling both halves comes with
 * the embedded backend, which removes the launcher entirely.
 */
async function buildStandaloneBinary(
  directory: string | undefined,
  target: BuildTarget,
  withRestore = false,
  deployFiles = false,
  release = false,
) {
  const project = await readProject(directory);
  console.log(dim(`Building a standalone ${project.config.name} (${target}, ${release ? "release, LTO" : "no LTO"})…`));
  try {
    const result = await buildStandalone({
      projectDir: project.directory,
      config: project.config,
      sourcePath: project.sourcePath,
      source: project.bundle.code,
      target,
      withRestore,
      release,
    });
    console.log(ok(`built ${result.outPath} (${(result.bytes / 1_000_000).toFixed(1)} MB)`));
    console.log(dim(`  run it: ${result.outPath}   ·   state lands in ./${project.config.name}.data`));
    if (!release)
      console.log(
        dim("  built without LTO (faster to build, slower to serve); add --release for the binary you publish"),
      );
    if (target === "linux-arm64") console.log(dim("  linux-arm64: runs on an aarch64 Linux box, not on this machine"));
    if (deployFiles && isLinuxTarget(target)) {
      const written = await writeDeployFiles({ name: project.config.name, target, binary: result.outPath });
      console.log(ok(`deploy files in ${written.dir}`));
      console.log(dim(`  ${written.files.join(" · ")}   ·   how to use them: docs/standalone.md`));
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `build --emit-only`: run the build up to and including writing
 * `sprout.generated.js` (prelude, bindings and handler, exactly what Porffor
 * would compile), print its path and stop. Every source and config check still
 * fails the build; no compiler, SQLite or BearSSL is acquired and no binary is
 * written.
 */
async function emitOnly(directory: string | undefined, target: BuildTarget, standalone: boolean) {
  const project = await readProject(directory);
  console.log(
    dim(`Emitting ${standalone ? "the standalone " : ""}${project.config.name} source (${target}, no native compile)…`),
  );
  try {
    const input = {
      projectDir: project.directory,
      config: project.config,
      sourcePath: project.sourcePath,
      source: project.bundle.code,
      target,
    };
    const { generatedPath } = standalone ? await emitStandalone(input) : await emitGenerated(input);
    console.log(generatedPath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** The standalone source unit the Cloud compile starts from (what `build --standalone --emit-only` prints). */
async function emitStandaloneUnit(directory: string | undefined): Promise<string> {
  const project = await readProject(directory);
  try {
    const { generatedPath } = await emitStandalone(
      {
        projectDir: project.directory,
        config: project.config,
        sourcePath: project.sourcePath,
        source: project.bundle.code,
        target: "linux-x86_64",
      },
      { forCloud: true },
    );
    return generatedPath;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** #62 — build for this machine, run it against a real broker, rebuild on save. */
const DEV_USAGE = "dev [project-dir] [--port <n>] [--no-watch] [-e, --env <name>] [--env-file <file>]...";

async function dev(args: string[]) {
  let directory: string | undefined;
  let portArg: string | undefined;
  // --env and --env-file are global flags, already taken out of `args` (global-flags.ts).
  const envName = globalFlags().env;
  const envFiles = globalFlags().envFiles.map((file) => resolve(file));
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === "--no-watch") continue;
    if (arg === "--port") {
      const value = args[at + 1];
      if (value === undefined || value.startsWith("--")) usageError(`${arg} needs a value`, DEV_USAGE);
      at += 1;
      portArg = value;
    } else if (!arg.startsWith("--") && directory === undefined) directory = arg;
  }
  const port = Number(portArg ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) usageError(`invalid --port: ${portArg}`, DEV_USAGE);
  if (envName !== undefined && !/^[A-Za-z0-9_-]+$/.test(envName))
    usageError("--env takes a name (letters, digits, - and _)", DEV_USAGE);
  for (const file of envFiles) if (!existsSync(file)) fail(`env file not found: ${file}`);
  const project = await readProject(directory);
  await refreshTypes(project.directory, project.config);
  console.log(dim(`Building ${project.config.name} for this machine (${hostTarget()})…`));
  await runDev({
    projectDir: project.directory,
    config: project.config,
    sourcePath: project.sourcePath,
    source: project.bundle.code,
    port,
    envFiles,
    envName,
    watch: !args.includes("--no-watch"),
    // Re-read from disk on every rebuild: the point of watching is that the
    // files changed, so the bundle captured at startup is stale by definition.
    rebuild: async () => {
      const next = await readProject(directory);
      await refreshTypes(next.directory, next.config);
      return { config: next.config, sourcePath: next.sourcePath, source: next.bundle.code };
    },
  });
}

/** #275: start a standalone binary with its port, data directory and secrets supplied at launch. */
async function run(args: string[]) {
  const result = parseRunArgs(args);
  if ("error" in result) usageError(result.error, RUN_USAGE);
  // --env-file is a global flag, already taken out of `args` (global-flags.ts).
  result.args.envFiles.unshift(...globalFlags().envFiles);
  let plan;
  try {
    plan = await planRun(result.args, { cwd: process.cwd(), inherited: process.env, config: globalFlags().config });
  } catch (error) {
    if (error instanceof RunError || error instanceof EnvFileError || error instanceof MissingSecretsError)
      fail(error.message);
    throw error;
  }
  for (const warning of plan.warnings) console.warn(amber(`! ${warning}`));
  for (const line of plan.summary) console.log(dim(line));
  if (result.args.check) {
    console.log(ok(`ready to launch ${basename(plan.binary)} (not started: --check)`));
    return;
  }
  console.log(ok(`launching ${plan.binary}`));
  const child = Bun.spawn([plan.binary], { env: plan.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  // Forward termination to the binary, which is the only process this started.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  const code = await child.exited;
  const signalNumber = child.signalCode ? osConstants.signals[child.signalCode] : undefined;
  process.exit(signalNumber === undefined ? code : 128 + signalNumber);
}

const PROVISION_FIELDS = [
  ["kv_namespaces", "kv"],
  ["d1_databases", "d1"],
  ["r2_buckets", "r2"],
  ["queues", "queue"],
] as const;

/**
 * #74 auto-provisioning, wrangler-style. A bare-string KV/D1/R2/queue binding
 * with no id gets an account-level resource created (`<project>-<binding>`) on
 * deploy, and the id is written back into `sproutboat.jsonc`. `--no-provision`
 * skips this — those bindings then get an ephemeral deploy-scoped store.
 */
async function provisionBindings(directory?: string): Promise<void> {
  const { configPath } = locate(directory);
  let source = await readFile(configPath, "utf8");
  const parsed = parseProjectConfig(source);
  if (!parsed.ok) return; // build() re-reads and reports the config error

  const bare: Array<{ field: string; kind: string; binding: string }> = [];
  for (const [field, kind] of PROVISION_FIELDS) {
    for (const ref of resourceRefs(parsed.value[field])) {
      if (!ref.id) bare.push({ field, kind, binding: ref.binding });
    }
  }
  if (bare.length === 0) return;

  const { apiUrl, token } = await apiCredentials();
  for (const { field, kind, binding } of bare) {
    const name = `${parsed.value.name}-${binding.toLowerCase().replace(/_/g, "-")}`;
    const body = await responseText(
      await fetch(`${apiUrl}/api/resources`, {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ kind, name, ifExists: "return" }),
      }),
      `could not provision a ${kind} resource for env.${binding}`,
    );
    const record = jsonObject(jsonObject(parseJsonValue(body))?.resource ?? null);
    if (!record || !isString(record.id)) fail(`provision response for env.${binding} was not a resource`);
    source = pinBindingId(source, field, binding, record.id);
    console.log(ok(`provisioned ${kind} ${bold(name)} → ${record.id}`));
  }
  await writeFile(configPath, source);
}

/** #79 — wrangler parity: drop the stored credential for an endpoint. */
async function logout(args: string[]) {
  const { apiUrl, account, target } = await parseLoginArgs(args);
  await printTarget(target);
  if ((await savedProfile(apiUrl))?.kind === "cloud") {
    const outcome = await guard(() => cloudLogout(apiUrl, account));
    if (outcome.kind === "none") {
      console.log(`no stored login for ${account ? `the team "${account}" on ` : ""}${apiUrl}`);
      return;
    }
    const how =
      outcome.server === "revoked"
        ? "revoked its key on the server"
        : outcome.server === "already-gone"
          ? "its key was already revoked on the server"
          : "could not reach the server, so the key may still be live: delete it under Settings, API keys";
    console.log(ok(`logged out of ${outcome.slug} on ${apiUrl} (${how})`));
    if (outcome.remaining.length > 0) console.log(dim(`still logged in to: ${outcome.remaining.join(", ")}`));
    if (envToken()) console.log(dim("SPROUTBOAT_API_TOKEN is set in this shell and still applies"));
    return;
  }
  const result = await forgetToken(apiUrl);
  if (!result.removed) {
    console.log(`no stored credential for ${apiUrl}`);
    return;
  }
  console.log(ok(`forgot the credential for ${apiUrl}`));
  if (result.activeApiUrl === undefined)
    console.log(dim("no active endpoint remains — the next command falls through to the default"));
}

/** `profile list` and `profile use <name>`: the stored profiles, and which one a command uses by default. */
async function profile(args: string[]) {
  const sub = args[0] ?? "list";
  if (sub === "use") {
    const name = args[1];
    if (!name || args.length > 2) usageError("profile use needs a profile name", "profile <list | use <name>>");
    if (!(await useProfile(name))) {
      const known = (await listProfiles()).map((entry) => entry.name);
      fail(
        `no profile named "${name}"${known.length > 0 ? ` (profiles: ${known.join(", ")})` : ""}; create it with \`sproutboat login --profile ${name}\``,
      );
    }
    console.log(ok(`${name} is now the default profile`));
    return;
  }
  if (sub !== "list" || args.length > 1)
    usageError(`profile: unknown subcommand "${sub}"`, "profile <list | use <name>>");
  const entries = await listProfiles();
  if (entries.length === 0) {
    console.log("no profiles stored; run `sproutboat login`");
    return;
  }
  const width = Math.max(...entries.map((entry) => entry.name.length));
  for (const { name, active, profile: stored } of entries) {
    const kind = stored.kind === "cloud" ? "Cloud" : stored.kind === "community" ? "Community" : "";
    const team = stored.kind === "cloud" && stored.team ? ` team ${stored.team}` : "";
    console.log(`${active ? "*" : " "} ${name.padEnd(width)}  ${stored.apiUrl}  ${dim(`${kind}${team}`.trim())}`);
  }
  console.log(dim("* is the default profile; pick another for one command with --profile <name>"));
}

/**
 * #79 — wrangler parity: which endpoint, and who the stored token belongs to.
 * The account comes from the control plane, so this also proves the token still
 * works rather than only reporting what is on disk.
 */
async function whoami(args: string[]) {
  const { apiUrl, target, account: wanted } = await parseLoginArgs(args);
  const fromEnv = envToken();
  const saved = await savedProfile(apiUrl);
  await printTarget(target);
  const kind = saved?.kind ?? (fromEnv ? await kindOf(apiUrl) : undefined);
  if (kind === "cloud") {
    const team = wanted ?? saved?.team ?? Object.keys(saved?.teams ?? {})[0];
    const token = fromEnv?.token ?? (team ? saved?.teams[team]?.token : undefined) ?? saved?.token;
    if (!token) {
      const hint = wanted
        ? `not logged in to the team "${wanted}"; run \`sproutboat login --account ${wanted}\``
        : "not logged in; run `sproutboat login`";
      console.log(`account   ${rose(hint)}`);
      process.exitCode = 1;
      return;
    }
    const who = await guard(() => fetchWhoami(apiUrl, token, fromEnv !== undefined));
    console.log(`kind      Sproutboat Cloud`);
    console.log(`team      ${who.slug}${who.name !== who.slug ? ` (${who.name})` : ""}`);
    console.log(
      `key       ${who.keyName || who.keyId}  ${dim(fromEnv ? `token from ${fromEnv.source}` : "stored login")}`,
    );
    if (who.permissions) console.log(`access    ${who.permissions}`);
    if (who.person) console.log(`email     ${who.person.email}`);
    const stored = Object.keys(saved?.teams ?? {});
    if (!fromEnv && stored.length > 1) console.log(dim(`logged in to ${stored.length} teams: ${stored.join(", ")}`));
    return;
  }
  const token = fromEnv?.token || (await savedToken(apiUrl));
  if (!token) {
    console.log(`account   ${dim("no stored token — run `sproutboat login`")}`);
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${apiUrl}/api/account`, { headers: { "x-api-key": token } });
  if (!response.ok) {
    console.log(
      `account   ${rose(response.status === 401 ? "token rejected — run `sproutboat login`" : `control plane said ${response.status}`)}`,
    );
    process.exitCode = 1;
    return;
  }
  const account = jsonObject(parseJsonValue(await response.text()));
  const profile = jsonObject(account?.profile ?? null);
  const user = jsonObject(account?.user ?? null);
  console.log(`account   ${isString(profile?.username) ? profile.username : "(no namespace reserved)"}`);
  if (user && isString(user.email)) console.log(`email     ${user.email}`);
}

async function deploy(args: string[]) {
  const flags = takeFlags(args, DEPLOY_FLAGS);
  const dryRun = args.includes("--dry-run");
  const { apiUrl: targetUrl, target } = await resolveApiUrl(flags["--api-url"]);
  await printTarget(target);
  const kind = await deployKind(targetUrl, dryRun);
  if (kind === "cloud") {
    if (args.includes("--artifact"))
      fail("--artifact deploys a prebuilt Community artifact; the Cloud builds your source: run deploy without it");
    await guard(() => deployCloud(args, targetUrl, flags));
    return;
  }
  if (flags["--secrets-file"] !== undefined)
    fail("--secrets-file is for the Cloud; on this endpoint set secrets with `sproutboat secrets put <NAME>`");
  const artifactIndex = args.indexOf("--artifact");
  const directory = args.find((arg, index) => !arg.startsWith("--") && index !== artifactIndex + 1);
  let projectName: string;
  let artifactDir: string;
  let config: SproutboatConfig | undefined;
  if (artifactIndex >= 0) {
    artifactDir = args[artifactIndex + 1]
      ? resolve(args[artifactIndex + 1])
      : usageError(
          "deploy: --artifact needs a directory",
          "deploy [project-dir] [--dry-run] [--artifact <dir>] [--no-wait]",
        );
    projectName = "";
  } else {
    // wrangler-style: create resources for id-less bindings and pin the ids
    // back into sproutboat.jsonc before the build bakes them into the artifact.
    if (!args.includes("--no-provision") && !dryRun) await provisionBindings(directory);
    const built = await build(directory);
    projectName = built.project.config.name;
    artifactDir = built.artifact.artifactDir;
    config = built.project.config;
    // After provisioning: ids may have been pinned into the config just now.
    await refreshTypes(built.project.directory, built.project.config);
  }
  const manifest = Bun.file(resolve(artifactDir, "manifest.json"));
  const sprout = Bun.file(resolve(artifactDir, "sprout"));
  if (!(await manifest.exists()) || !(await sprout.exists())) fail("artifact must contain manifest.json and sprout");
  const manifestValidation = validateManifest(await manifest.json());
  if (!manifestValidation.ok) fail(`invalid artifact manifest: ${manifestValidation.errors.join(", ")}`);
  const artifactManifest: ArtifactManifest = manifestValidation.value;
  if (artifactIndex >= 0) projectName = artifactManifest.project;

  printDeployReport(
    config ?? { name: projectName, main: "", compatibility_date: "(prebuilt artifact)" },
    artifactManifest,
    new Uint8Array(await sprout.arrayBuffer()),
    manifest.size,
  );
  if (dryRun) {
    console.log("\n--dry-run: not uploading.");
    return;
  }
  const { apiUrl, token } = await apiCredentials(flags["--api-url"]);
  const form = new FormData();
  form.set("manifest", new File([await manifest.arrayBuffer()], "manifest.json", { type: "application/json" }));
  form.set("sprout", new File([await sprout.arrayBuffer()], "sprout", { type: "application/octet-stream" }));

  // #1 — ship the sidecars `sproutboat build` produced so the server can start
  // the binding broker and serve static assets. Without bindings.json the broker
  // never spawns and every KV/D1/R2/secret/queue/cron/DO call is dead on the box.
  const bindingsFile = Bun.file(resolve(artifactDir, "bindings.json"));
  if (await bindingsFile.exists()) {
    form.set("bindings", new File([await bindingsFile.arrayBuffer()], "bindings.json", { type: "application/json" }));
  }
  const assetsManifestFile = Bun.file(resolve(artifactDir, "assets.json"));
  if (await assetsManifestFile.exists()) {
    // assets.json is written by `sproutboat build` from the AssetManifest contract.
    const assetsManifest: { files?: AssetFiles } = await assetsManifestFile.json();
    form.set(
      "assets_manifest",
      new File([await assetsManifestFile.arrayBuffer()], "assets.json", { type: "application/json" }),
    );
    for (const key of Object.keys(assetsManifest.files ?? {})) {
      const file = Bun.file(resolve(artifactDir, "assets", `.${key}`));
      if (!(await file.exists())) fail(`assets.json lists ${key} but assets${key} is missing — rebuild`);
      form.append("asset", new File([await file.arrayBuffer()], key));
    }
  }

  const response = await fetch(`${apiUrl}/api/projects/${projectName}/deployments`, {
    method: "POST",
    headers: { "x-api-key": token },
    body: form,
  });
  const body = await responseText(response, "deployment rejected");
  const deployed = parseUrlResponse(body);
  if (!deployed) fail("deployment response did not include a URL");
  if (deployed.unchanged) {
    console.log(ok(`nothing to deploy — ${projectName} is already serving this exact artifact`));
    console.log(`  ${deployed.url}`);
    return;
  }
  console.log(`\n${leaf("🌱")} ${bold(leaf(`Deployed ${projectName}`))}`);
  console.log(`  ${bold(deployed.url)}`);
  if (deployed.id)
    console.log(
      dim(`  version ${deployed.id}${deployed.artifact ? `  ·  artifact ${deployed.artifact.slice(0, 12)}` : ""}`),
    );
  for (const cron of config?.triggers?.crons ?? []) console.log(dim(`  schedule ${cron}`));
  const drift = parsePorfforDrift(body);
  if (drift) {
    console.warn(amber(`\n! Porffor pin changed: ${drift.from} -> ${drift.to}`));
    console.warn(dim(`  The previous live version stays frozen at ${drift.from}; this one is built with ${drift.to}.`));
    console.warn(
      dim(
        `  The alpha compiler's output can differ between pins (see COMPAT.md) — roll back if this version misbehaves.`,
      ),
    );
  }
  // Verify the edge actually answers (cert issuance + sprout boot). Say nothing
  // on success — "Deployed" already implied that; only speak up if it doesn't.
  if (!args.includes("--no-wait") && !(await waitForHealthy(deployed.url, 90_000))) {
    console.warn(
      amber(
        "  ! not serving after 90s — Caddy may still be issuing the cert, or the sprout is crashing (`sproutboat tail`, `tail --sprout`)",
      ),
    );
  }
}

/**
 * Poll the deployment URL until the edge returns any non-5xx response. Connection
 * and TLS errors (the cert is issued on the first HTTPS request) count as "not
 * ready yet". Returns false on timeout without failing the deploy — the artifact
 * is already active server-side.
 */
async function waitForHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wait = 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "manual" });
      if (response.status < 500) return true;
    } catch {
      /* DNS / TLS-not-yet-issued / connection refused — keep waiting */
    }
    await Bun.sleep(Math.min(wait, Math.max(0, deadline - Date.now())));
    if (wait < 5000) wait += 1000;
  }
  return false;
}

async function parseLoginArgs(args: string[], options: { allowNewProfile?: boolean } = {}) {
  let token: string | undefined;
  let account: string | undefined;
  // --api-url is a global flag (global-flags.ts); resolveApiUrl reads it.
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] === "--token" && value) token = value;
    else if (args[index] === "--account" && value) account = value;
    else
      usageError(
        `unexpected argument "${args[index]}"`,
        "login [--api-url <url>] [--token <token>] [--account <team>]",
      );
  }
  const { apiUrl, source, target } = await resolveApiUrl(undefined, options);
  return { apiUrl, source, target, token, account };
}

/** Say which profile a login went to, and when it left the machine's default profile pointed elsewhere. */
function reportSaved(saved: { profile: string; activeProfile: string; activeApiUrl: string }): void {
  console.log(dim(`  stored as the profile "${saved.profile}"`));
  if (saved.activeProfile !== saved.profile)
    console.log(
      dim(
        `  the default profile stays "${saved.activeProfile}" (${saved.activeApiUrl}); use --profile ${saved.profile}, or \`sproutboat profile use ${saved.profile}\``,
      ),
    );
}

async function login(args: string[]) {
  const { apiUrl, target, token: directToken, account } = await parseLoginArgs(args, { allowNewProfile: true });
  await printTarget(target);
  const kind = await kindOf(apiUrl);
  if (kind === undefined && !directToken) fail(`cannot reach ${apiUrl}; check the address and your network`);
  if (kind === "cloud") {
    await guard(() => cloudLogin(apiUrl, directToken, account));
    return;
  }
  // Self-hosted / non-interactive: skip the browser flow and store the token
  // the admin already holds (e.g. SPROUTBOAT_BOOTSTRAP_TOKEN).
  if (directToken) {
    const saved = await saveToken(apiUrl, directToken, kind);
    console.log(`Saved credentials for ${apiUrl}.`);
    reportSaved(saved);
    return;
  }
  const response = await fetch(`${apiUrl}/api/cli/authorizations`, { method: "POST" });
  const body = await responseText(response, "could not start login");
  const authorization = parseAuthorization(body);
  if (!authorization) fail("login response did not include a valid authorization request");
  const verificationUrl = new URL(authorization.verificationUri, `${apiUrl}/`).toString();
  const openCommand =
    process.platform === "darwin"
      ? ["open", verificationUrl]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", verificationUrl]
        : ["xdg-open", verificationUrl];
  try {
    Bun.spawn(openCommand, { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log(`Open ${verificationUrl}`);
  }
  console.log("Opening the browser to approve this CLI login.");
  console.log(`Confirm code: ${authorization.userCode}`);
  while (new Date(authorization.expiresAt).getTime() > Date.now()) {
    await Bun.sleep(Math.max(authorization.interval, 1) * 1000);
    const exchange = await fetch(`${apiUrl}/api/cli/authorizations/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: authorization.deviceCode }),
    });
    if (exchange.status === 428) continue;
    const result = await exchange.text();
    if (!exchange.ok) fail(`login failed (${exchange.status}): ${result}`);
    const token = parseToken(result);
    if (!token) fail("login response did not include a CLI token");
    const saved = await saveToken(apiUrl, token, "community");
    console.log(ok("login approved — credentials saved for this endpoint"));
    reportSaved(saved);
    return;
  }
  fail("login expired before approval");
}

const DEPLOY_FLAGS = ["--api-url", "--account", "--module", "--sproutd", "--generation", "--secrets-file"] as const;
type DeployFlag = (typeof DEPLOY_FLAGS)[number];

function guardSync(step: () => void): void {
  try {
    step();
  } catch (error) {
    if (error instanceof CloudError) return fail(error.message);
    throw error;
  }
}

async function readSecretsFileOrFail(path: string) {
  try {
    return await readSecretsFile(path);
  } catch (error) {
    if (error instanceof CloudError || error instanceof EnvFileError) return fail(error.message);
    throw error;
  }
}

/** Run a Cloud step; its CloudError becomes a printed failure. */
async function guard<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof CloudError) return fail(error.message);
    throw error;
  }
}

/** Remove `--name value` pairs from `args` (in place) and return their values. */
function takeFlags<Name extends string>(args: string[], names: readonly Name[]) {
  const values: { [flag in Name]?: string } = {};
  for (const name of names) {
    const at = args.indexOf(name);
    if (at < 0) continue;
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--"))
      usageError(`${name} needs a value`, "deploy [project-dir] [${name} <value>]");
    values[name] = value;
    args.splice(at, 2);
  }
  return values;
}

/** Cloud or Community, or undefined when the endpoint cannot be reached. */
async function kindOf(apiUrl: string) {
  try {
    return await detectKind(apiUrl);
  } catch {
    return undefined;
  }
}

async function deployKind(apiUrl: string, dryRun: boolean) {
  const stored = envToken() ? undefined : (await savedProfile(apiUrl))?.kind;
  if (stored) return stored;
  const kind = await kindOf(apiUrl);
  if (kind === undefined && !dryRun) fail(`cannot reach ${apiUrl}; check the address and your network`);
  return kind ?? "community";
}

function openInBrowser(url: string): boolean {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const headless =
    process.platform === "linux" &&
    (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) || process.env.SSH_CONNECTION);
  if (headless || !Bun.which(opener)) return false;
  try {
    Bun.spawn(opener === "cmd" ? ["cmd", "/c", "start", "", url] : [opener, url], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function terminalIo(): CloudIo {
  return {
    log: (line) => console.log(line),
    warn: (line) => console.warn(amber(line)),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    openUrl: openInBrowser,
    sleep: (ms) => Bun.sleep(ms),
    choose: async (question, choices) => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(question);
        choices.forEach((choice, at) => console.log(`  ${at + 1}) ${choice}`));
        for (;;) {
          const answer = (await rl.question("> ")).trim();
          const picked = choices[Number(answer) - 1] ?? choices.find((choice) => choice === answer);
          if (picked) return picked;
        }
      } finally {
        rl.close();
      }
    },
  };
}

async function cloudLogin(apiUrl: string, directToken: string | undefined, account: string | undefined) {
  if (directToken) {
    const stored = await storeGivenKey(apiUrl, directToken);
    console.log(ok(`saved the key for ${stored.slug} on ${apiUrl}`));
    return;
  }
  const cancel = () => {
    console.log("\nlogin cancelled");
    process.exit(130);
  };
  process.once("SIGINT", cancel);
  const done = await loginAndStore({
    apiUrl,
    io: terminalIo(),
    hostname: osHostname(),
    os: `${osPlatform()} ${osArch()}`,
    account,
  });
  process.off("SIGINT", cancel);
  console.log(
    ok(
      `logged in to ${bold(done.slug)}${done.team.role ? ` as ${done.team.role}` : ""} with the key "${done.keyName}"`,
    ),
  );
  console.log(dim("  revoke it any time under Settings, API keys, or with `sproutboat logout`"));
  reportSaved(done);
}

async function deployCloud(args: string[], apiUrl: string, flags: ReturnType<typeof takeFlags<DeployFlag>>) {
  const dryRun = args.includes("--dry-run");
  const io = terminalIo();
  const directory = args.find((arg) => !arg.startsWith("--"));
  const project = await readProjectConfig(directory);
  const name = project.config.name;
  if (!CLOUD_PROJECT_RE.test(name))
    fail(`"${name}" is not a valid Cloud app name (3 to 32 characters: lowercase letters, digits, dashes)`);

  const account = flags["--account"] ?? project.account;
  let session: Awaited<ReturnType<typeof resolveSession>> | undefined;
  try {
    session = await resolveSession({
      apiUrl,
      io,
      account,
      login: async (hint) => {
        if (dryRun) throw new CloudError("not logged in (--dry-run does not start a login)");
        process.once("SIGINT", () => process.exit(130));
        return loginAndStore({ apiUrl, io, hostname: osHostname(), os: `${osPlatform()} ${osArch()}`, account: hint });
      },
    });
  } catch (error) {
    if (!dryRun || !(error instanceof CloudError)) throw error;
    io.warn(`! ${error.message}; the plan below uses a placeholder team`);
  }
  const team = session?.slug ?? account ?? "<team>";
  const hosts = [hostFor(name, team)];

  const cfg = project.config;
  const unsent = Object.entries({
    kv_namespaces: cfg.kv_namespaces?.length,
    d1_databases: cfg.d1_databases?.length,
    r2_buckets: cfg.r2_buckets?.length,
    queues: cfg.queues?.length,
    analytics_engine_datasets: cfg.analytics_engine_datasets?.length,
    durable_objects: Object.keys(cfg.durable_objects ?? {}).length,
    ratelimiters: cfg.ratelimiters?.length,
    "triggers.crons": cfg.triggers?.crons?.length,
  })
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([key]) => key);
  if (unsent.length > 0)
    io.warn(
      `! ${unsent.join(", ")} in sproutboat.jsonc are not sent to the Cloud by the CLI yet; the app runs without them`,
    );

  const services = cfg.services ?? [];
  guardSync(() => checkServiceBindings(name, services, cfg.compatibility_date));
  let secretValues: Record<string, string> | undefined;
  const secretsFile = flags["--secrets-file"];
  if (secretsFile !== undefined) {
    const read = await readSecretsFileOrFail(resolve(secretsFile));
    for (const warning of read.warnings) io.warn(`! ${warning}`);
    secretValues = read.values;
  }

  const assets = project.config.assets ? buildAssetBundle(project.directory, project.config.assets) : undefined;
  // Regular deploys build in the Cloud from the bundled source. --module (a prebuilt module) and --sproutd with
  // --generation (compile here) are the operator paths; the Cloud refuses a module from a team key.
  let modulePath = flags["--module"];
  const compiled =
    modulePath === undefined && Boolean(flags["--sproutd"] ?? flags["--generation"] ?? process.env.SPROUTBOAT_SPROUTD);
  const fromSource = modulePath === undefined && !compiled;
  if (compiled) {
    modulePath = resolve(tmpdir(), `sproutboat-${name}-${process.pid}.so`);
    console.log(dim("Compiling the module (sproutd)…"));
    await compileModule({
      project: name,
      emit: () => emitStandaloneUnit(directory),
      sproutd: flags["--sproutd"] ?? process.env.SPROUTBOAT_SPROUTD,
      generation: flags["--generation"] ?? process.env.SPROUTBOAT_GENERATION,
      out: modulePath,
      bun: process.versions.bun ? process.execPath : (Bun.which("bun") ?? "bun"),
    });
  } else if (modulePath !== undefined && !existsSync(modulePath)) fail(`no such module: ${modulePath}`);

  console.log(`app       ${bold(name)}`);
  console.log(`team      ${team}${session ? "" : dim("  (not resolved)")}`);
  console.log(`endpoint  ${apiUrl}`);
  console.log(`route     https://${hosts[0]}`);
  if (assets) console.log(`assets    ${assets.files} files`);
  if (services.length > 0)
    console.log(`services  ${services.map((entry) => `${entry.binding} -> ${entry.service}`).join(", ")}`);
  if (secretValues) console.log(`secrets   ${Object.keys(secretValues).length} from ${secretsFile} (set, others kept)`);
  if (fromSource) console.log(`build     in the Cloud, from your bundled source`);
  if (dryRun) {
    console.log("\n--dry-run: not uploading.");
    if (fromSource) console.log(dim("  A real deploy bundles your source, uploads it and has the Cloud build it."));
    if (compiled) rmSync(modulePath!, { force: true });
    return;
  }
  const tokenFromEnv = session!.source !== "stored login";
  const noWait = args.includes("--no-wait");
  const printResult = (result: {
    created: boolean;
    generation: number | undefined;
    url: string | undefined;
    applied: boolean | "skipped";
    buildId?: string;
  }) => {
    if (result.generation === undefined) {
      console.log(`\n${leaf("🌱")} ${bold(leaf(`Build queued for ${name}`))}`);
      console.log(dim(`  status  ${apiUrl}/v1/builds/${result.buildId}`));
      return;
    }
    console.log(`\n${leaf("🌱")} ${bold(leaf(`${result.created ? "Created" : "Updated"} ${name}`))}`);
    if (result.url) {
      console.log(`  ${bold(result.url)}`);
    }
    console.log(dim(`  generation ${result.generation}  ·  team ${team}`));
    if (result.applied === false) {
      fail(
        `generation ${result.generation} is saved but no host has applied it after 120 s; it applies when a host is available (check with: sproutboat whoami, or the dashboard)`,
      );
    }
  };
  if (fromSource) {
    const sourcePath = await emitStandaloneUnit(directory);
    console.log(`  Bundling   ${cfg.main} (${formatKiB(Bun.file(sourcePath).size)})`);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once("SIGINT", interrupt);
    try {
      const result = await buildAndDeploy(
        {
          apiUrl,
          token: session!.token,
          tokenFromEnv,
          project: name,
          services,
          compatibilityDate: cfg.compatibility_date,
          secrets: secretValues,
          hosts,
          sourcePath,
          cli: { version: CLI_VERSION },
          assets,
          noWait,
        },
        io,
        controller.signal,
      );
      printResult(result);
    } catch (error) {
      if (error instanceof Interrupted) {
        console.error(error.message);
        process.exit(130);
      }
      throw error;
    } finally {
      process.off("SIGINT", interrupt);
    }
    return;
  }
  try {
    const result = await deployToCloud(
      {
        apiUrl,
        token: session!.token,
        tokenFromEnv,
        project: name,
        hosts,
        modulePath: modulePath!,
        assets,
        noWait,
        services,
        compatibilityDate: cfg.compatibility_date,
        secrets: secretValues,
      },
      io,
    );
    printResult(result);
  } finally {
    if (compiled) rmSync(modulePath!, { force: true });
  }
}

async function apiCredentials(explicitApiUrl?: string) {
  const { apiUrl, source } = await resolveApiUrl(explicitApiUrl);
  const token = envToken()?.token || (await savedToken(apiUrl));
  if (!token) fail("not logged in; run sproutboat login or set SPROUTBOAT_API_TOKEN for this command");
  return { apiUrl, token, source };
}

async function versions(args: string[]) {
  const sub = args[0];
  if (sub !== "list" && sub !== "view") {
    usageError(
      sub ? `versions: unknown subcommand "${sub}"` : "versions: missing subcommand",
      "versions <list | view <version-id>> [project-dir]",
    );
  }
  args.shift();

  if (sub === "view") {
    const id = args.shift();
    if (!id) usageError("versions view: missing <version-id>", "versions view <version-id> [project-dir]");
    const [project, { apiUrl, token }] = await Promise.all([readProjectConfig(args[0]), apiCredentials()]);
    const body = await responseText(
      await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments/${encodeURIComponent(id)}`, {
        headers: { "x-api-key": token },
      }),
      "could not read that version",
    );
    const detail = jsonObject(parseJsonValue(body));
    if (!detail) fail("could not parse version response");
    const manifest = jsonObject(detail.manifest ?? null);
    console.log(`${bold(String(detail.id))} ${detail.active ? ok("active") : dim("superseded")}`);
    console.log(`  route     ${String(detail.hostname)}`);
    console.log(`  artifact  ${String(detail.artifact)}`);
    console.log(
      `  deployed  ${String(detail.deployedAt)}${isString(detail.deployedBy) ? ` by ${detail.deployedBy}` : ""}`,
    );
    if (manifest) {
      console.log(
        `  built     ${String(manifest.builtAt)} · porffor ${String(manifest.porfforVersion)} · ${String(manifest.binarySize)} bytes`,
      );
    } else if (isString(detail.manifestError)) {
      console.log(`  ! manifest unavailable: ${detail.manifestError}`);
    }
    const resources = Array.isArray(detail.resources) ? detail.resources.map((entry) => jsonObject(entry)) : [];
    for (const resource of resources) {
      if (resource)
        console.log(`  bound     ${String(resource.kind)} ${String(resource.name)} ${dim(String(resource.id))}`);
    }
    return;
  }

  const [project, { apiUrl, token }] = await Promise.all([readProjectConfig(args[0]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments`, {
    headers: { "x-api-key": token },
  });
  const deployments = parseVersionList(await responseText(response, "could not list versions"));
  if (!deployments) fail("could not parse versions response");
  for (const deployment of deployments)
    console.log(
      `${deployment.active ? "*" : " "} ${deployment.id} ${deployment.artifact.slice(0, 12)} ${deployment.deployedAt}`,
    );
}

async function rollback(args: string[]) {
  const id = args[0];
  if (!id) usageError("rollback: missing <version-id>", "rollback <version-id> [project-dir]");
  const [project, { apiUrl, token }] = await Promise.all([readProjectConfig(args[1]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments/${id}/activate`, {
    method: "POST",
    headers: { "x-api-key": token },
  });
  const deployment = parseUrlResponse(await responseText(response, "rollback rejected"));
  if (!deployment) fail("rollback response did not include a URL");
  console.log(ok(`rolled back ${project.config.name}`));
  console.log(deployment.url);
}

/** #268: follow a standalone binary's SB_LOG=json records from a file or stdin. Local only: no login. */
async function tailLog(parsed: TailArgs, file: string) {
  // Ctrl-C (or a terminated pipe reader) ends the stream and exits 0.
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  process.stdout.on("error", () => controller.abort());
  const sink = {
    format: parsed.format,
    filter: new LogFilter({ status: parsed.status, method: parsed.method, search: parsed.search }),
    signal: controller.signal,
    stdout: (text: string) => void process.stdout.write(text),
    stderr: (text: string) => void process.stderr.write(text),
  };
  try {
    if (file === "-") await readLogStream(Bun.stdin.stream(), sink);
    else await followLog({ ...sink, path: resolve(file), lines: parsed.lines, follow: parsed.follow });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function tail(args: string[]) {
  const result = parseTailArgs(args);
  if ("error" in result) usageError(result.error, TAIL_USAGE);
  const parsed = result.args;
  if (parsed.file !== undefined) return tailLog(parsed, parsed.file);
  const [project, { apiUrl, token }] = await Promise.all([readProjectConfig(parsed.dir), apiCredentials()]);
  const base = `${apiUrl}/api/projects/${project.config.name}`;
  if (parsed.recent || parsed.sprout) {
    const response = await fetch(`${base}/logs/${parsed.sprout ? "sprout" : "recent"}`, {
      headers: { "x-api-key": token },
    });
    process.stdout.write(await responseText(response, "could not read logs"));
    return;
  }
  // Ctrl-C (or a terminated pipe reader) ends the stream and exits 0.
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  process.stdout.on("error", () => controller.abort());
  const query = tailQuery(parsed);
  try {
    await runTail({
      url: `${base}/tail${query ? `?${query}` : ""}`,
      headers: { "x-api-key": token },
      format: parsed.format,
      signal: controller.signal,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

type DomainView = {
  hostname: string;
  verified: boolean;
  verification: { type: string; name: string; value: string } | null;
  serverAddresses: string[];
  warning?: string;
};
function parseDomain(source: string): DomainView | undefined {
  const record = jsonObject(parseJsonValue(source));
  if (!record || !isString(record.hostname) || !isBoolean(record.verified)) return undefined;
  const v = jsonObject(record.verification ?? null);
  const verification =
    v && isString(v.type) && isString(v.name) && isString(v.value)
      ? { type: v.type, name: v.name, value: v.value }
      : null;
  const serverAddresses = Array.isArray(record.serverAddresses) ? record.serverAddresses.filter(isString) : [];
  return {
    hostname: record.hostname,
    verified: record.verified,
    verification,
    serverAddresses,
    warning: isString(record.warning) ? record.warning : undefined,
  };
}
function printDomain(domain: DomainView) {
  const status = domain.verified ? "verified" : "unverified";
  console.log(`${status.padEnd(10)} ${domain.hostname}`);
  if (domain.verification) {
    console.log("  add these DNS records, then run: sproutboat domains verify " + domain.hostname);
    console.log(`  ${domain.verification.type}  ${domain.verification.name}  "${domain.verification.value}"`);
    if (domain.serverAddresses[0]) {
      console.log(
        `  A    ${domain.hostname}  ${domain.serverAddresses[0]}   (point the hostname here, DNS-only / not proxied)`,
      );
    }
  }
  if (domain.warning) console.log(amber(`  ! ${domain.warning}`));
}

async function domains(args: string[]) {
  const sub =
    args[0] && !args[0].startsWith("-") && ["list", "add", "verify", "delete"].includes(args[0])
      ? args.shift()!
      : "list";
  const host = sub === "list" ? undefined : args.shift();
  if (sub !== "list" && !host)
    usageError(`domains ${sub}: missing <hostname>`, `domains ${sub} <hostname> [project-dir]`);
  const [project, { apiUrl, token }] = await Promise.all([readProjectConfig(args[0]), apiCredentials()]);
  const base = `${apiUrl}/api/projects/${project.config.name}/domains`;
  const auth = { "x-api-key": token };

  if (sub === "list") {
    const response = await fetch(base, { headers: auth });
    const body = await responseText(response, "could not list domains");
    const list = parseJsonValue(body);
    if (!Array.isArray(list)) fail("could not parse domains response");
    if (list.length === 0) {
      console.log("no custom domains");
      return;
    }
    for (const entry of list) {
      const d = parseDomain(JSON.stringify(entry));
      if (d) printDomain(d);
    }
    return;
  }
  if (sub === "delete") {
    const response = await fetch(`${base}/${host}`, { method: "DELETE", headers: auth });
    await responseText(response, "delete rejected");
    console.log(ok(`removed ${host}`));
    return;
  }
  const url = sub === "add" ? base : `${base}/${host}/verify`;
  const init =
    sub === "add"
      ? {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ hostname: host }),
        }
      : { method: "POST", headers: auth };
  const response = await fetch(url, init);
  const domain = parseDomain(await responseText(response, `${sub} rejected`));
  if (!domain) fail(`${sub} response was not a domain record`);
  printDomain(domain);
}

async function secrets(args: string[]) {
  const sub = args[0] && ["list", "put", "delete"].includes(args[0]) ? args.shift()! : "list";
  const flags = takeFlags(args, ["--api-url", "--account"] as const);

  // `--value` is opt-in; without it the value comes from stdin, so a secret does
  // not land in shell history. It is also what disambiguates the positionals:
  // `secrets put NAME <value> [project-dir]` could not tell a value from a path,
  // and read the value as the project directory.
  let inlineValue: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--value") inlineValue = args[(index += 1)];
    else positional.push(args[index]);
  }

  const name = sub === "list" ? undefined : positional.shift();
  if (sub !== "list" && !name) usageError(`secrets ${sub}: missing <NAME>`, `secrets ${sub} <NAME> [project-dir]`);
  if (name && !/^[A-Z][A-Z0-9_]*$/.test(name)) fail("secret name must be UPPER_SNAKE_CASE");
  const { apiUrl: targetUrl } = await resolveApiUrl(flags["--api-url"]);
  if ((await deployKind(targetUrl, false)) === "cloud") {
    await guard(() => cloudSecrets(sub, name, inlineValue, positional[0], targetUrl, flags["--account"]));
    return;
  }
  const [project, { apiUrl, token }] = await Promise.all([readProjectConfig(positional[0]), apiCredentials()]);
  const base = `${apiUrl}/api/projects/${project.config.name}/secrets`;
  const auth = { "x-api-key": token };

  if (sub === "list") {
    const body = await responseText(await fetch(base, { headers: auth }), "could not list secrets");
    const parsed = jsonObject(parseJsonValue(body));
    const names = parsed && Array.isArray(parsed.names) ? parsed.names.filter(isString) : [];
    console.log(names.length ? names.join("\n") : "no secrets");
    return;
  }
  if (sub === "delete") {
    await responseText(await fetch(`${base}/${name}`, { method: "DELETE", headers: auth }), "delete rejected");
    console.log(ok(`removed ${name}`));
    return;
  }

  const value = inlineValue ?? (await Bun.stdin.text()).replace(/\r?\n$/, "");
  if (!value) fail("no value — pipe it on stdin, or pass --value <value>");
  await responseText(
    await fetch(`${base}/${name}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }),
    "put rejected",
  );
  console.log(ok(`set ${name} — applies on the next deploy or sprout restart`));
}

/** The signed-in session for a Cloud endpoint as the credentials every Cloud call takes; logs in first when it can. */
async function cloudCredentials(apiUrl: string, account: string | undefined) {
  const io = terminalIo();
  const session = await resolveSession({
    apiUrl,
    io,
    account,
    login: (hint) =>
      loginAndStore({ apiUrl, io, hostname: osHostname(), os: `${osPlatform()} ${osArch()}`, account: hint }),
  });
  return { apiUrl, token: session.token, tokenFromEnv: session.source !== "stored login" };
}

/** `secrets` against a Sproutboat Cloud app: by name, apart from deploys, which never wipe them (Wrangler's model). */
async function cloudSecrets(
  sub: string,
  name: string | undefined,
  inlineValue: string | undefined,
  directory: string | undefined,
  apiUrl: string,
  accountFlag: string | undefined,
) {
  const project = await readProjectConfig(directory);
  const app = project.config.name;
  const credentials = await cloudCredentials(apiUrl, accountFlag ?? project.account);
  if (sub === "list") {
    const names = await listCloudSecrets(credentials, app);
    console.log(names.length ? names.join("\n") : "no secrets");
    return;
  }
  if (sub === "delete") {
    await deleteCloudSecret(credentials, app, name!);
    console.log(ok(`removed ${name} from ${app}; applies when a host picks up the new record`));
    return;
  }
  const value = inlineValue ?? (await Bun.stdin.text()).replace(/\r?\n$/, "");
  if (!value) fail("no value: pipe it on stdin, or pass --value <value>");
  await putCloudSecret(credentials, app, name!, value);
  console.log(ok(`set ${name} on ${app}; applies when a host picks up the new record`));
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return !/^n/i.test((await rl.question(`${question} [Y/n] `)).trim());
  } finally {
    rl.close();
  }
}

/** `d1 execute` and `d1 migrations create | list | apply`: the local dev database unless --remote, as in Wrangler. */
async function d1Contents(args: string[]) {
  const area = args.shift()!;
  let sub = "execute";
  if (area === "migrations") {
    const word = args.shift();
    if (word !== "create" && word !== "list" && word !== "apply")
      usageError(
        word ? `d1 migrations: unknown subcommand "${word}"` : "d1 migrations: missing subcommand",
        "d1 migrations <create | list | apply> <database> ...",
      );
    sub = word;
  }
  const usage =
    sub === "execute" ? EXECUTE_USAGE : sub === "create" ? CREATE_USAGE : sub === "list" ? LIST_USAGE : APPLY_USAGE;
  let parsed: ReturnType<typeof parseD1Flags>;
  try {
    parsed = parseD1Flags(args, usage);
  } catch (error) {
    if (error instanceof D1UsageError) return usageError(error.message, error.usage);
    throw error;
  }
  const { positional, flags } = parsed;
  const [database, message] = positional;
  if (!database) usageError(`${sub === "execute" ? "d1 execute" : `d1 migrations ${sub}`}: missing <database>`, usage);
  if (sub === "create" && (!message || positional.length > 2))
    usageError("d1 migrations create: missing <name>", usage);
  if (sub !== "create" && positional.length > 1) usageError(`unexpected argument "${positional[1]}"`, usage);
  if (sub === "create" && (flags.local || flags.remote))
    usageError("d1 migrations create works on files only; drop --local and --remote", usage);

  const project = await readProjectConfig();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const io: D1Io = {
    log: (line) => console.log(line),
    note: (line) => console.error(line),
    interactive,
    confirm: confirmOnTerminal,
  };
  try {
    await guard(() => d1Run());
  } catch (error) {
    if (error instanceof D1UsageError) usageError(error.message, error.usage);
    throw error;
  }

  async function d1Run() {
    const binding = pickBinding(project.config, database!);
    const dir = resolve(project.directory, project.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    if (sub === "create") {
      await createMigration(dir, message!, io);
      return;
    }
    let runner: Runner;
    if (flags.remote) {
      const { apiUrl: targetUrl } = await resolveApiUrl(flags.apiUrl);
      const app = project.config.name;
      if ((await deployKind(targetUrl, false)) === "cloud") {
        const credentials = await cloudCredentials(targetUrl, flags.account ?? project.account);
        const call = makeCall(credentials);
        runner = remoteRunner({
          label: `${app} database ${binding.binding}`,
          project: app,
          binding: binding.binding,
          community: false,
          send: async (body) => {
            const reply = await call({
              method: "POST",
              path: `/v1/apps/${app}/d1/${binding.binding}/query`,
              json: body,
              ok: DATA_ERROR_STATUSES,
            });
            return { status: reply.status, body: reply.body, headers: reply.headers };
          },
        });
      } else {
        const { apiUrl, token } = await apiCredentials(flags.apiUrl);
        runner = remoteRunner({
          label: `${app} database ${binding.binding}`,
          project: app,
          binding: binding.binding,
          community: true,
          send: async (body) => {
            const response = await fetch(`${apiUrl}/api/projects/${app}/d1/${binding.binding}/query`, {
              method: "POST",
              headers: { "x-api-key": token, "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            return { status: response.status, body: parseBody(await response.text().catch(() => "")) };
          },
        });
      }
    } else {
      runner = localRunner(localDatabasePath(project.directory, binding, flags.persistTo));
    }
    if (sub === "execute") await executeSql({ flags, runner, remote: flags.remote, io, cwd: process.cwd() });
    else if (sub === "list") await listMigrations(runner, dir, io);
    else await applyMigrations(runner, dir, io);
  }
}

/**
 * #79 — one command per storage product (`kv`, `d1`, `r2`, `queues`), each with
 * the same five verbs, over that product's own `/api/<product>` collection.
 *
 * Wrangler nests two of its four (`kv namespace create`, `r2 bucket create`)
 * and leaves `d1 create` and `queues create` flat. The nesting is there to
 * separate the container from its contents, which the verb already does — so
 * ours are uniform, and contents take their own noun when they exist
 * (`kv key get`, `r2 object put`).
 */
/** The account's resources of one kind, by name. */
async function storageRows(base: string, auth: Record<string, string>, product: StorageProduct): Promise<JsonObject[]> {
  const body = await responseText(await fetch(base, { headers: auth }), `could not list ${product.plural}`);
  const parsed = jsonObject(parseJsonValue(body));
  return (parsed && Array.isArray(parsed.resources) ? parsed.resources : [])
    .map((entry) => jsonObject(entry))
    .filter((entry): entry is JsonObject => Boolean(entry));
}

/** Resolve a name to its `<kind>_<id>` handle — the API addresses rows by id. */
function idForName(rows: JsonObject[], name: string, product: StorageProduct): string {
  const match = rows.find((row) => row.name === name);
  if (!match || !isString(match.id)) fail(`no ${product.noun} named "${name}"`);
  return String(match.id);
}

async function storage(key: string, args: string[]) {
  const product = STORAGE_PRODUCTS.find((entry) => entry.name === key)!;
  const sub = args[0] && STORAGE_VERBS.some((verb) => verb === args[0]) ? args.shift()! : "list";
  // The five verbs take names, never options (the contents commands and `checkOptions` handle the others).
  const stray = args.find((arg) => arg.startsWith("-") && arg !== "-");
  if (stray) usageError(`${key}: unknown option ${stray.split("=")[0]}`, usageOf(key));
  const { apiUrl, token } = await apiCredentials();
  const base = `${apiUrl}/api/${product.name}`;
  const auth = { "x-api-key": token };

  if (sub === "list") {
    const rows = await storageRows(base, auth, product);
    if (rows.length === 0) {
      console.log(`no ${product.plural}`);
      return;
    }
    for (const row of rows) {
      const bound = Array.isArray(row.projects) ? row.projects.filter(isString) : [];
      console.log(
        `${String(row.id).padEnd(30)} ${String(row.name).padEnd(24)} ${bound.length ? bound.join(", ") : dim("unbound")}`,
      );
    }
    return;
  }

  const name = args.shift();
  if (!name) usageError(`${key} ${sub}: missing <name>`, `${key} ${sub} <name>`);

  if (sub === "create") {
    const body = await responseText(
      await fetch(base, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
      "create rejected",
    );
    const record = jsonObject(jsonObject(parseJsonValue(body))?.resource ?? null);
    if (!record || !isString(record.id)) fail("create response was not a resource");
    console.log(ok(`created ${product.noun} ${bold(String(record.name))}`));
    console.log(record.id);
    return;
  }

  const rows = await storageRows(base, auth, product);
  const id = idForName(rows, name, product);

  if (sub === "info") {
    const row = rows.find((entry) => entry.id === id)!;
    const bound = Array.isArray(row.projects) ? row.projects.filter(isString) : [];
    console.log(`${bold(String(row.name))}  ${dim(String(row.id))}`);
    console.log(`  created  ${String(row.createdAt)}`);
    console.log(`  bound to ${bound.length ? bound.join(", ") : "nothing"}`);
    return;
  }

  if (sub === "rename") {
    const next = args.shift();
    if (!next) usageError(`${key} rename: missing <new-name>`, `${key} rename <name> <new-name>`);
    await responseText(
      await fetch(`${base}/${id}`, {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      }),
      "rename rejected",
    );
    console.log(ok(`renamed ${name} → ${next}`));
    return;
  }

  await responseText(await fetch(`${base}/${id}`, { method: "DELETE", headers: auth }), "delete rejected");
  console.log(ok(`deleted ${product.noun} ${name}`));
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function writeAtomic(
  path: string,
  chunks: AsyncIterable<string> | readonly string[],
  overwrite: boolean,
): Promise<void> {
  const destination = resolve(path);
  if (!overwrite && (await Bun.file(destination).exists())) fail(`${path} already exists; pass --force to replace it`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const cleanup = () => {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* best effort during process shutdown */
    }
  };
  process.once("exit", cleanup);
  const file = await open(temporary, "wx", 0o600);
  try {
    for await (const chunk of chunks) await file.write(chunk);
    await file.sync();
    await file.close();
    await rename(temporary, destination);
    process.off("exit", cleanup);
  } catch (error) {
    await file.close().catch(() => undefined);
    cleanup();
    process.off("exit", cleanup);
    throw error;
  }
}

async function kvContents(args: string[]): Promise<void> {
  const area = args.shift();
  if (!area || !["key", "bulk", "export"].includes(area))
    usageError("kv: unknown contents command", "kv <key | bulk | export> ...");
  const namespace = area === "export" ? args.shift() : args[1];
  if (!namespace) usageError(`kv ${area}: missing <namespace>`, `kv ${area} <namespace> ...`);
  const { apiUrl, token } = await apiCredentials();
  const rows = await storageRows(`${apiUrl}/api/kv`, { "x-api-key": token }, STORAGE_PRODUCTS[0]);
  const id = idForName(rows, namespace, STORAGE_PRODUCTS[0]);
  const base = `${apiUrl}/api/kv/${id}`;
  const auth = { "x-api-key": token };

  if (area === "key") {
    const verb = args.shift();
    args.shift();
    if (!verb || !["list", "get", "put", "delete"].includes(verb))
      usageError("kv key: unknown operation", "kv key <list | get | put | delete> <namespace> ...");
    if (verb === "list") {
      const query = new URLSearchParams();
      for (const flag of ["--prefix", "--cursor", "--limit"] as const) {
        const value = option(args, flag);
        if (value !== undefined) query.set(flag.slice(2), value);
      }
      const body = await responseText(await fetch(`${base}/keys?${query}`, { headers: auth }), "list rejected");
      console.log(body);
      return;
    }
    const key = args.shift();
    if (!key) usageError(`kv key ${verb}: missing <key>`, `kv key ${verb} <namespace> <key>`);
    const url = `${base}/keys/${encodeURIComponent(key)}`;
    if (verb === "get") {
      const body = await responseText(await fetch(url, { headers: auth }), "get rejected");
      const record = jsonObject(parseJsonValue(body));
      if (!record || !isString(record.value)) fail("get response did not contain a value");
      const output = option(args, "--output");
      if (output) await writeAtomic(output, [record.value], args.includes("--force"));
      else console.log(args.includes("--text") ? record.value : JSON.stringify({ key, value: record.value }, null, 2));
      return;
    }
    if (verb === "put") {
      const path = option(args, "--path");
      const positional = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "--path");
      if (path && positional)
        usageError(
          "kv key put: use a value or --path, not both",
          "kv key put <namespace> <key> [value] [--path <file>]",
        );
      const value = path ? await readFile(resolve(path), "utf8") : (positional ?? (await Bun.stdin.text()));
      await responseText(
        await fetch(url, {
          method: "PUT",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ value }),
        }),
        "put rejected",
      );
      console.log(ok(`set ${key}`));
      return;
    }
    if (!args.includes("--yes")) fail(`this permanently deletes "${key}"; re-run with --yes`);
    await responseText(await fetch(url, { method: "DELETE", headers: auth }), "delete rejected");
    console.log(ok(`deleted ${key}`));
    return;
  }

  if (area === "bulk") {
    const verb = args.shift();
    args.shift();
    const input = args.shift();
    if (!verb || !["get", "put", "delete"].includes(verb) || !input)
      usageError(
        "kv bulk: expected an operation, namespace, and JSON file",
        "kv bulk <get | put | delete> <namespace> <file>",
      );
    if (verb === "delete" && !args.includes("--yes")) fail("bulk deletion requires --yes");
    const parsed = parseJsonValue(await readFile(resolve(input), "utf8"));
    if (!Array.isArray(parsed) || parsed.length === 0) fail("bulk input must be a non-empty JSON array");
    const responses: unknown[] = [];
    let changed = 0;
    const failures: unknown[] = [];
    for (let start = 0; start < parsed.length; start += 100) {
      const body = await responseText(
        await fetch(`${base}/bulk/${verb}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(parsed.slice(start, start + 100)),
        }),
        `bulk ${verb} rejected`,
      );
      const result = parseJsonValue(body);
      if (verb === "get" && Array.isArray(result)) responses.push(...result);
      else {
        const summary = jsonObject(result);
        changed += Number(summary?.written ?? summary?.deleted ?? 0);
        if (Array.isArray(summary?.failures)) failures.push(...summary.failures);
      }
    }
    const result = verb === "get" ? responses : { [verb === "put" ? "written" : "deleted"]: changed, failures };
    const output = option(args, "--output");
    if (output) await writeAtomic(output, [JSON.stringify(result, null, 2) + "\n"], args.includes("--force"));
    else console.log(JSON.stringify(result, null, 2));
    return;
  }

  const output = option(args, "--output");
  if (!output)
    usageError(
      "kv export: missing --output <file>",
      "kv export <namespace> --output <dump.json> [--prefix <prefix>] [--force]",
    );
  const prefix = option(args, "--prefix") ?? "";
  async function* dump(): AsyncGenerator<string> {
    yield "[\n";
    let cursor = "";
    let first = true;
    do {
      const query = new URLSearchParams({ prefix, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const listed = jsonObject(
        parseJsonValue(
          await responseText(await fetch(`${base}/keys?${query}`, { headers: auth }), "export list rejected"),
        ),
      );
      const keys = Array.isArray(listed?.keys) ? listed.keys.filter(isString) : [];
      if (keys.length) {
        const values = parseJsonValue(
          await responseText(
            await fetch(`${base}/bulk/get`, {
              method: "POST",
              headers: { ...auth, "content-type": "application/json" },
              body: JSON.stringify(keys),
            }),
            "export read rejected",
          ),
        );
        if (!Array.isArray(values)) fail("export response was not an array");
        for (const entry of values) {
          const record = jsonObject(entry);
          if (!record || !isString(record.key) || !isString(record.value)) continue;
          yield `${first ? "" : ",\n"}  ${JSON.stringify({ key: record.key, value: record.value })}`;
          first = false;
        }
      }
      cursor = isString(listed?.cursor) ? listed.cursor : "";
    } while (cursor);
    yield "\n]\n";
  }
  await writeAtomic(output, dump(), args.includes("--force"));
  console.log(ok(`exported ${namespace} to ${output}`));
}

async function deleteProject(args: string[]) {
  // `sproutboat delete [project-dir] [--name <project>] --yes` — flags in any order.
  const positional: string[] = [];
  let confirmed = false;
  let explicitName: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") confirmed = true;
    else if (arg === "--name") explicitName = args[(index += 1)];
    else if (!arg.startsWith("-")) positional.push(arg);
    else usageError(`delete: unknown flag "${arg}"`, "delete [project-dir] [--name <project>] --yes");
  }

  const { apiUrl, token } = await apiCredentials();
  const name = explicitName ?? (await readProjectConfig(positional[0])).config.name;
  if (!confirmed) fail(`this permanently removes "${name}", every version, and its route — re-run with --yes`);

  const url = `${apiUrl}/api/projects/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`;
  const body = await responseText(
    await fetch(url, { method: "DELETE", headers: { "x-api-key": token } }),
    "delete rejected",
  );

  let result: JsonObject = {};
  try {
    result = jsonObject(parseJsonValue(body)) ?? {};
  } catch {
    /* a 2xx already confirmed the delete */
  }
  const versions = isSafeInteger(result.versionsRemoved) ? result.versionsRemoved : 0;
  const routes = Array.isArray(result.routeRemoved) ? result.routeRemoved.filter(isString) : [];
  const failed = Array.isArray(result.artifactCleanupFailed) ? result.artifactCleanupFailed.filter(isString) : [];

  console.log(ok(`deleted ${name} — ${versions} version${versions === 1 ? "" : "s"} removed`));
  for (const route of routes) console.log(`  released ${route}`);
  if (failed.length) console.log(`  ! ${failed.length} artifact file(s) left on disk — remove them manually`);
}

/** `sproutboat` alone or with -h/--help/help: the friendly grouped list, exit 0. */
function help(): never {
  console.log(helpText());
  process.exit(0);
}

/** An unrecognised command: a short pointer on stderr, exit 2 (misuse, not failure). */
function usage(): never {
  console.error(`${rose("✗")} unknown command "${command}"\n  ${dim("run `sproutboat` for the list of commands")}`);
  process.exit(2);
}

async function toolchain(args: string[]): Promise<void> {
  if (args[0] !== "doctor" || args.slice(1).some((arg) => arg !== "--json"))
    usageError("expected toolchain doctor", "toolchain doctor [--json]");
  const report = inspectToolchain();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`host: ${report.host}`);
  console.log(`cache: ${report.cacheRoot}`);
  console.log(`Porffor: ${report.porffor.version} (${report.porffor.present ? "ready" : "acquired on first build"})`);
  console.log(`  ${report.porffor.path}${report.porffor.override ? " (override)" : ""}`);
  console.log(`Zig: ${report.zig.version} (${report.zig.platform ?? "unsupported host"})`);
  console.log(`  ${report.zig.path ?? "set SPROUTBOAT_ZIG to a supported Zig binary"}`);
  console.log(
    `  ${report.zig.present ? "ready" : "acquired on first deployment build"}${report.zig.override ? " (override)" : ""}`,
  );
  console.log(
    `SQLite: ${report.sqlite.version} (${report.sqlite.present ? "cached" : "acquired for standalone builds"})`,
  );
  console.log(`  ${report.sqlite.path}`);
  console.log(
    `BearSSL: ${report.bearssl.version} (${report.bearssl.present ? "cached" : "acquired for standalone builds"})`,
  );
  console.log(`  ${report.bearssl.path}`);
  console.log(
    `host compiler: ${report.prerequisites.cc ?? "missing: install Xcode Command Line Tools or a C compiler"}`,
  );
  console.log(`archiver: ${report.prerequisites.ar ?? "missing: install an archiver"}`);
  console.log(`archive extractor: ${report.prerequisites.tar ?? "missing: install tar with xz support"}`);
  if (process.platform === "darwin")
    console.log(`macOS SDK tools: ${report.prerequisites.xcrun ?? "missing: run xcode-select --install"}`);
  if (process.platform === "darwin")
    console.log(`macOS SDK: ${report.prerequisites.sdk ?? "missing: run xcode-select --install"}`);
}

/** `sproutboat <command> --help`: that command's full usage line + summary, exit 0. */
/** The grammar line of a command, for usage errors. */
function usageOf(name: string): string {
  const found = COMMANDS.find((c) => c.name === name);
  return found?.args ? `${name} ${found.args}` : name;
}

function commandHelp(name: string): never {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) usage();
  console.log(`${dim(`usage: ${CLI_NAME} ${name}${found.args ? ` ${found.args}` : ""}`)}\n\n${found.summary}`);
  process.exit(0);
}

const BASH_COMPLETION = (names: string) =>
  `_sproutboat_complete() {\n  local cur=\${COMP_WORDS[COMP_CWORD]}\n  if [ "$COMP_CWORD" -eq 1 ]; then\n    COMPREPLY=($(compgen -W "${names}" -- "$cur"))\n  fi\n}\ncomplete -F _sproutboat_complete ${CLI_NAME}\n`;
const ZSH_COMPLETION = (names: string) => `#compdef ${CLI_NAME}\n_arguments '1: :(${names})'\n`;
const FISH_COMPLETION = (names: string) => `complete -c ${CLI_NAME} -n "__fish_use_subcommand" -a "${names}"\n`;

/** `sproutboat complete [shell]`: a static completion script for the top-level commands. */
function complete(shell?: string): void {
  const names = COMMANDS.map((c) => c.name).join(" ");
  const scripts = { bash: BASH_COMPLETION(names), zsh: ZSH_COMPLETION(names), fish: FISH_COMPLETION(names) };
  const key = shell ?? process.env.SHELL?.split("/").pop() ?? "bash";
  const script = key === "bash" || key === "zsh" || key === "fish" ? scripts[key] : undefined;
  if (!script) usageError(`complete: unsupported shell "${key}"`, "complete [bash | zsh | fish]");
  console.log(script);
}

const GLOBAL_USAGE =
  "<command> [-c, --config <file>] [--cwd <dir>] [-e, --env <name>] [--env-file <file>]... [--profile <name>] [--api-url <url>] [-v, --version]";
const parsedArgv = extractGlobalFlags(process.argv.slice(2));
if ("error" in parsedArgv) usageError(parsedArgv.error, GLOBAL_USAGE);
const globals = parsedArgv.flags;
if (globals.version) {
  console.log(`sproutboat ${CLI_VERSION}`);
  process.exit(0);
}
if (globals.cwd !== undefined) {
  try {
    process.chdir(globals.cwd);
  } catch {
    fail(`--cwd: no such directory: ${globals.cwd}`);
  }
}
setGlobalFlags(globals);
const [command, ...args] = parsedArgv.rest;
if (command === undefined || command === "help" || command === "-h" || command === "--help") help();
if (args.includes("-h") || args.includes("--help")) commandHelp(command);

// A flag a command cannot honour is an error, not a quiet no-op: `deploy --env staging` must not deploy.
if (globals.env !== undefined && command !== "dev")
  usageError(
    `${command} does not use --env: it only selects .dev.vars.<name> and the .env.<name> files for \`dev\`, and sproutboat.jsonc has no environments`,
    GLOBAL_USAGE,
  );
if (globals.envFiles.length > 0 && command !== "dev" && command !== "run")
  usageError(`${command} does not read env files; --env-file is for \`dev\` and \`run\``, GLOBAL_USAGE);
if (globals.profile !== undefined && !PROFILE_NAME.test(globals.profile))
  usageError(`"${globals.profile}" is not a profile name (letters, digits, . _ -; at most 64)`, GLOBAL_USAGE);
if (globals.apiUrl !== undefined) {
  if (!ENDPOINT_COMMANDS.has(command))
    usageError(
      `${command} does not talk to a control plane, so --api-url means nothing here; to choose where the other commands go use --profile <name> or SPROUTBOAT_API_URL`,
      GLOBAL_USAGE,
    );
  if (!/^https?:\/\/[^\s/]+/i.test(globals.apiUrl))
    usageError(
      `--api-url "${globals.apiUrl}" is not an http(s) URL, such as https://dash.sproutboat.com`,
      GLOBAL_USAGE,
    );
}
// What each command accepts: an unknown flag is an error, `--flag=value` becomes `--flag value`, and a URL is never
// read as a project directory (options.ts).
const checked = checkOptions(command, args);
if ("error" in checked) usageError(`${command}: ${checked.error}`, usageOf(command));
args.splice(0, args.length, ...checked.args);

// A local log needs no network: skip the version check for it (#268).
if (!(command === "tail" && args.some((arg) => arg === "--file" || arg.startsWith("--file="))))
  await notifyIfOutdated(CLI_VERSION);

switch (command) {
  case "init":
    await init(args[0]);
    break;
  case "check":
    await check(args[0]);
    break;
  case "types":
    await types(args[0]);
    break;
  case "dev":
    await dev(args);
    break;
  case "run":
    await run(args);
    break;
  case "build": {
    const withRestore = args.includes("--with-restore");
    if (withRestore && (!args.includes("--standalone") || args.includes("--emit-only")))
      usageError(
        "--with-restore requires --standalone without --emit-only",
        "build --standalone --with-restore [--target host] [project-dir]",
      );
    const targetAt = args.indexOf("--target");
    const targetArg = targetAt >= 0 ? args[targetAt + 1] : undefined;
    const target = targetAt < 0 ? "linux-x86_64" : parseTarget(targetArg);
    if (target === undefined)
      usageError(
        `unknown --target ${targetArg === undefined ? "(missing)" : `"${targetArg}"`}`,
        `build [--target ${TARGET_NAMES}] [project-dir]`,
      );
    const directory = args.find((arg, at) => !arg.startsWith("--") && (targetAt < 0 || at !== targetAt + 1));
    const deployFiles = args.includes("--deploy-files");
    if ((deployFiles || target === "linux-arm64") && !args.includes("--standalone"))
      usageError(
        `${deployFiles ? "--deploy-files" : "--target linux-arm64"} requires --standalone: the platform runs x86_64`,
        "build --standalone [--target linux-x64 | linux-arm64] [--deploy-files] [project-dir]",
      );
    if (deployFiles && !isLinuxTarget(target))
      usageError(
        "--deploy-files needs a Linux target",
        "build --standalone --target linux-x64 --deploy-files [project-dir]",
      );
    if (args.includes("--emit-only")) await emitOnly(directory, target, args.includes("--standalone"));
    else if (args.includes("--standalone"))
      await buildStandaloneBinary(directory, target, withRestore, deployFiles, isReleaseBuild(args));
    else await build(directory, target);
    break;
  }
  case "toolchain":
    await toolchain(args);
    break;
  case "login":
    await login(args);
    break;
  case "logout":
    await logout(args);
    break;
  case "whoami":
    await whoami(args);
    break;
  case "profile":
    await profile(args);
    break;
  case "deploy":
    await deploy(args);
    break;
  case "versions":
    await versions(args);
    break;
  case "rollback":
    await rollback(args);
    break;
  case "domains":
    await domains(args);
    break;
  case "secrets":
    await secrets(args);
    break;
  case "kv":
    if (["key", "bulk", "export"].includes(args[0] ?? "")) await kvContents(args);
    else await storage(command, args);
    break;
  case "d1":
    if (["execute", "migrations"].includes(args[0] ?? "")) await d1Contents(args);
    else await storage(command, args);
    break;
  case "r2":
  case "queues":
    await storage(command, args);
    break;
  case "tail":
    await tail(args);
    break;
  case "delete":
    await deleteProject(args);
    break;
  case "complete":
    complete(args[0]);
    break;
  default:
    usage();
}
