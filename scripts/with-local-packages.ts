#!/usr/bin/env bun
/**
 * Run a command against local `@sproutboat/{runtime,toolchain,wire}` checkouts.
 *
 *   bun scripts/with-local-packages.ts <path-to-sproutboat-packages> [--only runtime,toolchain,wire] -- <command...>
 *
 * Moves each `node_modules/@sproutboat/<pkg>` aside, symlinks
 * `<packages>/packages/<pkg>` in its place, runs the command with inherited
 * stdio, then puts the original entries back. The restore runs whatever the
 * command does: a non-zero exit, a throw here, SIGINT or SIGTERM. Only SIGKILL
 * can skip it, and the next run repairs that before it starts (the moved-aside
 * entry is left in a known place for exactly that reason).
 *
 * Refuses to run in the main checkout when it has uncommitted changes. Work in
 * progress lives there, and anything already running from it (a dev server, a
 * watcher) would silently pick up the linked packages. Use a worktree instead.
 */
import { existsSync, lstatSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGES = ["runtime", "toolchain", "wire"] as const;
type Pkg = (typeof PACKAGES)[number];
const isPkg = (value: string): value is Pkg => PACKAGES.some((pkg) => pkg === value);

const USAGE =
  "usage: bun scripts/with-local-packages.ts <path-to-sproutboat-packages> [--only runtime,toolchain,wire] -- <command...>";

function fail(message: string): never {
  console.error(`with-local-packages: ${message}`);
  process.exit(2);
}

// ---- arguments ----------------------------------------------------------

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator === -1) fail(`missing "--" before the command\n${USAGE}`);
const ours = argv.slice(0, separator);
const command = argv.slice(separator + 1);
if (command.length === 0) fail(`no command after "--"\n${USAGE}`);

let packagesRoot: string | undefined;
let only: Pkg[] | undefined;
for (let i = 0; i < ours.length; i++) {
  const arg = ours[i];
  if (arg === "--only" || arg.startsWith("--only=")) {
    const value = arg === "--only" ? ours[++i] : arg.slice("--only=".length);
    if (!value) fail(`--only needs a value\n${USAGE}`);
    const names = value.split(",").map((name) => name.trim());
    const unknown = names.filter((name) => !isPkg(name));
    if (unknown.length) fail(`unknown package ${unknown.join(", ")} (expected ${PACKAGES.join(", ")})`);
    only = names.filter(isPkg);
  } else if (arg === "-h" || arg === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (arg.startsWith("-")) {
    fail(`unknown option ${arg}\n${USAGE}`);
  } else if (packagesRoot === undefined) {
    packagesRoot = resolve(arg);
  } else {
    fail(`unexpected argument ${arg}\n${USAGE}`);
  }
}
if (!packagesRoot) fail(`missing the path to a sproutboat-packages checkout\n${USAGE}`);
if (!existsSync(resolve(packagesRoot, "packages")))
  fail(`${packagesRoot} has no packages/ directory: is it a sproutboat-packages checkout?`);

// ---- safety: never touch a dirty main checkout --------------------------

const cliRoot = resolve(import.meta.dir, "..");
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cliRoot, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}
const gitDir = resolve(cliRoot, git("rev-parse", "--git-dir"));
const commonDir = resolve(cliRoot, git("rev-parse", "--git-common-dir"));
const linkedWorktree = gitDir !== commonDir;
if (!linkedWorktree && git("status", "--porcelain") !== "") {
  fail(
    `refusing to run: ${cliRoot} is the main checkout and has uncommitted changes.\n` +
      "Relinking its node_modules would change what that work runs against. Use a worktree:\n" +
      `  git -C ${cliRoot} worktree add /tmp/sb-cli-local origin/main\n` +
      "  cd /tmp/sb-cli-local && bun install --frozen-lockfile\n" +
      `  bun scripts/with-local-packages.ts ${packagesRoot} -- <command...>`,
  );
}

// ---- link ---------------------------------------------------------------

const scope = resolve(cliRoot, "node_modules/@sproutboat");
const entryPath = (pkg: Pkg) => resolve(scope, pkg);
const backupPath = (pkg: Pkg) => resolve(scope, `.${pkg}.with-local-packages-backup`);
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Put one package's original entry back. Synchronous so the exit hook can use it. */
function restore(pkg: Pkg): void {
  const entry = entryPath(pkg);
  const backup = backupPath(pkg);
  if (!exists(backup)) return;
  if (exists(entry)) {
    // Only ever remove our own symlink, never a real directory.
    if (!lstatSync(entry).isSymbolicLink()) {
      console.error(`with-local-packages: ${entry} is not a symlink, leaving ${backup} for you to inspect`);
      return;
    }
    rmSync(entry);
  }
  renameSync(backup, entry);
}

// A run killed with SIGKILL leaves a backup behind: repair that first.
for (const pkg of PACKAGES) {
  if (exists(backupPath(pkg))) {
    console.error(`with-local-packages: restoring node_modules/@sproutboat/${pkg} left over from an interrupted run`);
    restore(pkg);
  }
}

const requested = only ?? PACKAGES.filter((pkg) => existsSync(resolve(packagesRoot!, "packages", pkg, "package.json")));
if (requested.length === 0) fail(`no runtime, toolchain or wire package under ${packagesRoot}/packages`);
for (const pkg of requested) {
  if (!existsSync(resolve(packagesRoot, "packages", pkg, "package.json")))
    fail(`${packagesRoot}/packages/${pkg} has no package.json`);
  if (!exists(entryPath(pkg))) fail(`node_modules/@sproutboat/${pkg} is missing: run bun install first`);
}
if (!existsSync(resolve(packagesRoot, "node_modules")))
  console.error(
    `with-local-packages: warning: ${packagesRoot} has no node_modules; ` +
      "the linked packages resolve their own imports from there, so run bun install in it if anything fails to resolve",
  );

const linked: Pkg[] = [];
let restored = false;
function restoreAll(): void {
  if (restored) return;
  restored = true;
  for (const pkg of linked.toReversed()) {
    try {
      restore(pkg);
    } catch (error) {
      console.error(`with-local-packages: could not restore ${pkg}: ${String(error)}`);
      process.exitCode = 1;
    }
  }
  const leftover = linked.filter((pkg) => exists(backupPath(pkg)));
  if (leftover.length === 0) console.error(`with-local-packages: restored ${linked.join(", ")}`);
}
// The last line of defence: runs on any exit this process gets to see.
process.on("exit", restoreAll);

let child: ReturnType<typeof Bun.spawn> | undefined;
let signalled: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // A second signal means "stop now": kill the command, the restore still runs.
    if (signalled && child) child.kill("SIGKILL");
    signalled = signal;
    // Ctrl-C already reached the command through the process group; SIGTERM
    // and SIGHUP sent to this process alone are passed on.
    if (child && signal !== "SIGINT") child.kill(signal);
    if (!child) {
      restoreAll();
      process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
    }
  });
}

try {
  for (const pkg of requested) {
    const target = resolve(packagesRoot, "packages", pkg);
    renameSync(entryPath(pkg), backupPath(pkg));
    linked.push(pkg);
    symlinkSync(target, entryPath(pkg), "dir");
    console.error(`with-local-packages: @sproutboat/${pkg} -> ${readlinkSync(entryPath(pkg))}`);
  }

  child = Bun.spawn(command, { cwd: process.cwd(), stdio: ["inherit", "inherit", "inherit"] });
  const code = await child.exited;
  restoreAll();
  if (signalled) process.exit(128 + (signalled === "SIGINT" ? 2 : signalled === "SIGTERM" ? 15 : 1));
  process.exit(child.signalCode ? 1 : code);
} catch (error) {
  restoreAll();
  fail(error instanceof Error ? error.message : String(error));
}
