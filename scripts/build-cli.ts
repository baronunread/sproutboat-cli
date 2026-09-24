/**
 * Build platform package executable(s). npm's tiny root launcher resolves one
 * of these at install time.
 *
 * Default (no args): build the host's own target only — what CI's per-platform
 * matrix runners want, one native build each, no cross-compilation involved.
 *
 * `--all`: cross-compile all four targets from this one machine (`bun build
 * --compile` can target any `bun-<os>-<arch>` regardless of host — verified
 * against real Linux/macOS output, not just docs). For a maintainer building
 * every platform package locally without waiting on CI.
 *
 * `--target <os>-<arch>`: build exactly one named target, host or not. CI's
 * darwin-x64 leg uses this to cross-build on an arm64 macOS runner, because
 * GitHub's only x64 macOS image (`macos-13`) routinely sits queued for half an
 * hour while every other leg finishes in one minute.
 */
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureZigArchive, type ZigPlatform } from "../src/toolchain";

type Target = { platform: "darwin" | "linux"; arch: "arm64" | "x64"; bunTarget: string; zigPlatform: ZigPlatform };

const TARGETS: Target[] = [
  { platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64", zigPlatform: "aarch64-macos" },
  { platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64", zigPlatform: "x86_64-macos" },
  { platform: "linux", arch: "arm64", bunTarget: "bun-linux-arm64", zigPlatform: "aarch64-linux" },
  { platform: "linux", arch: "x64", bunTarget: "bun-linux-x64", zigPlatform: "x86_64-linux" },
];

function hostTarget(): Target {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!platform || !arch) throw new Error(`unsupported release host ${process.platform}/${process.arch}`);
  const match = TARGETS.find((t) => t.platform === platform && t.arch === arch);
  if (!match) throw new Error(`no target entry for ${platform}/${arch}`);
  return match;
}

const root = resolve(import.meta.dir, "..");

async function buildOne(target: Target): Promise<void> {
  const packageDir = resolve(root, "platform-packages", `${target.platform}-${target.arch}`);
  const out = resolve(packageDir, "bin", "sproutboat");
  await mkdir(resolve(out, ".."), { recursive: true });
  await rm(resolve(packageDir, "bin", "esbuild"), { force: true });
  // SAFETY: package.json is this release's manifest and npm requires its version.
  const version = ((await Bun.file(resolve(root, "package.json")).json()) as { version: string }).version;
  // SAFETY: every checked-in platform package manifest owns a required string version.
  const platformVersion = ((await Bun.file(resolve(packageDir, "package.json")).json()) as { version: string }).version;
  if (platformVersion !== version)
    throw new Error(`platform package version ${platformVersion} does not match root ${version}`);
  console.log(`building ${target.platform}-${target.arch}...`);
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      `--define:process.env.SPROUTBOAT_CLI_VERSION=${JSON.stringify(version)}`,
      "--outfile",
      out,
      "src/main.ts",
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`compile failed for ${target.platform}-${target.arch}`);
  // The compressed archive (~50 MB), not the ~400 MB extracted install: Zig's
  // lib/ carries libc/libc++ sources for every target it can cross-compile to,
  // which only matters once, on extract. `ensureZig` (src/toolchain.ts) looks
  // for this file next to the running executable before ever hitting the
  // network, and extracts it into the ordinary toolchain cache on first use --
  // same shape as the vendored uWebSockets archive.
  await copyFile(await ensureZigArchive(target.zigPlatform), resolve(packageDir, "bin", "zig.tar.xz"));
  await copyFile(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(packageDir, "THIRD_PARTY_NOTICES.md"));
  await chmod(out, 0o755);
}

function named(spec: string): Target {
  const match = TARGETS.find((t) => `${t.platform}-${t.arch}` === spec);
  if (!match)
    throw new Error(
      `unknown target ${spec}; expected one of ${TARGETS.map((t) => `${t.platform}-${t.arch}`).join(", ")}`,
    );
  return match;
}

const all = process.argv.includes("--all");
const only = process.argv[process.argv.indexOf("--target") + 1];
const selected = all ? TARGETS : process.argv.includes("--target") ? [named(only ?? "")] : [hostTarget()];
for (const target of selected) await buildOne(target);
