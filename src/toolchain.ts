/**
 * The build toolchain: a pinned Zig (the linux-x86_64 cross-compiler Porffor
 * shells out to for `--musl`) plus version stamps for the artifact manifest.
 *
 * Zig is fetched once to ~/.cache/sproutboat/zig-<version>/ and reused. No
 * Docker, no root. Override with SPROUTBOAT_ZIG=/path/to/zig.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
// @ts-expect-error Bun's file loader returns the embedded asset path in a compiled executable.
import embeddedUwsArchive from "../vendor/uwebsockets-360c276d-musl.tar.xz" with { type: "file" };
import { cachedPorfforRoot, PORFFOR_CHANNEL, PORFFOR_COMMIT } from "./porffor-toolchain";

export const ZIG_VERSION = "0.16.0";

/** The `<arch>-<os>` platforms ziglang.org publishes a tarball for that we pin. */
type ZigPlatform = "x86_64-linux" | "aarch64-linux" | "x86_64-macos" | "aarch64-macos";

// sha256 of the official ziglang.org tarballs for ZIG_VERSION, keyed by
// `<arch>-<os>` (the download naming). Bump alongside ZIG_VERSION.
const ZIG_SHA256 = {
  "x86_64-linux": "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
  "aarch64-linux": "ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17",
  "x86_64-macos": "0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7",
  "aarch64-macos": "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
} satisfies Record<ZigPlatform, string>;

// Pinned Porffor identity comes from porffor-toolchain.ts. PORFFOR_VERSION overrides.
// When bumping this pin (#55): run the monorepo's `bun run diff` against the
// frozen reference handlers and update its COMPAT.md for any new mismatch before
// releasing — the alpha compiler's output can shift between pins. Checked by
// hand at bump time, not in CI.
// uWebSockets commit Porffor alpha-4 fetches for the native-fetch server.
const UWS_COMMIT = "360c276d";
const UWS_COMMIT_FULL = "360c276d609d59af56ae6932adb95154ace9f15f";

// `vendor/uwebsockets-<UWS_COMMIT>-musl.tar.xz` ships in the package: the
// checked-out, patched, `zig cc -target x86_64-linux-musl`-built uWebSockets
// tree (headers + `uSockets/uSockets.a`). Regenerate + re-pin the sha whenever
// the `porffor` pin (and thus UWS_COMMIT_FULL) changes — `bun tools/prebuild-uws.ts`
// or the `uws-prebuild` workflow.
const UWS_TARBALL_SHA256 = "e83736f3f8cf9d56a1ebe6ea61625a7af12386763374d47c14cff472ada7484a";

function platformKey(): ZigPlatform {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : null;
  if (!arch || !os)
    throw new Error(
      `no pinned Zig for ${process.platform}/${process.arch} — set SPROUTBOAT_ZIG to a zig ${ZIG_VERSION} binary`,
    );
  return `${arch}-${os}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

/** Absolute path to a usable `zig` binary, downloading it on first use. */
export async function ensureZig(): Promise<string> {
  const override = process.env.SPROUTBOAT_ZIG;
  if (override) {
    if (!existsSync(override)) throw new Error(`SPROUTBOAT_ZIG=${override} does not exist`);
    return override;
  }
  const key = platformKey();
  const home = homedir();
  const dir = resolve(home, ".cache/sproutboat", `zig-${ZIG_VERSION}`);
  const bin = resolve(dir, "zig");
  if (existsSync(bin)) return bin;

  const url = `https://ziglang.org/download/${ZIG_VERSION}/zig-${key}-${ZIG_VERSION}.tar.xz`;
  const expected = ZIG_SHA256[key];
  console.log(`Fetching Zig ${ZIG_VERSION} (${key}, one-time)...`);
  await mkdir(dir, { recursive: true });
  const archive = resolve(dir, "zig.tar.xz");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download Zig: ${url} (${response.status})`);
  await Bun.write(archive, response);

  const actual = await sha256File(archive);
  if (expected && actual !== expected) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Zig download sha256 mismatch\n  expected ${expected}\n  got      ${actual}`);
  }

  // `tar -xJ` (xz) works on macOS bsdtar and GNU tar with xz on PATH.
  const untar = Bun.spawn(["tar", "-xJf", archive, "-C", dir, "--strip-components=1"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([untar.exited, new Response(untar.stderr).text()]);
  if (code !== 0) throw new Error(`could not extract Zig (needs \`tar\` with xz support): ${err.trim()}`);
  await rm(archive, { force: true });
  if (!existsSync(bin)) throw new Error("Zig archive did not contain a `zig` binary");
  await chmod(bin, 0o755);
  return bin;
}

function uwsCommitFull(): string {
  try {
    const src = readFileSync(resolve(porfforRoot(), "compiler/uwebsockets.js"), "utf8");
    return /UWS_COMMIT\s*=\s*['"]([0-9a-f]{40})/.exec(src)?.[1] ?? UWS_COMMIT_FULL;
  } catch {
    return UWS_COMMIT_FULL;
  }
}

/** Thrown when the prebuilt uWebSockets archive is missing or fails its checksum. */
export class UwsUnavailableError extends Error {}

/** Path to the vendored prebuilt archive for the given short commit. */
export function uwsVendorArchive(short: string): string {
  return short === UWS_COMMIT_FULL.slice(0, 8)
    ? embeddedUwsArchive
    : resolve(import.meta.dir, "..", "vendor", `uwebsockets-${short}-musl.tar.xz`);
}

/**
 * Seed `~/.cache/porffor/deps/uWebSockets-<commit>-musl/` with the checked-out,
 * patched, `x86_64-linux-musl`-built uWebSockets tree so Porffor's own
 * `ensureUWebSockets` / `ensureUSocketsBuilt` short-circuit — the first build
 * then needs no `git` and no `make`, only Zig.
 *
 * The archive ships in the package (`vendor/`). No-ops if the cache is already
 * populated. Throws `UwsUnavailableError` if the archive is missing or fails its
 * checksum; the caller decides whether to fall back to Porffor's git + make path.
 *
 * `SPROUTBOAT_UWS_TARBALL=/path/to/archive.tar.xz` overrides the vendored one.
 */
export async function ensureUWebSockets(): Promise<void> {
  const commit = uwsCommitFull();
  const short = commit.slice(0, 8);
  const depsRoot = resolve(homedir(), ".cache/porffor/deps");
  const dir = resolve(depsRoot, `uWebSockets-${commit}-musl`);
  if (existsSync(resolve(dir, "src/App.h")) && existsSync(resolve(dir, "uSockets/uSockets.a"))) return;

  const archive = process.env.SPROUTBOAT_UWS_TARBALL || uwsVendorArchive(short);
  if (!existsSync(archive)) {
    throw new UwsUnavailableError(
      process.env.SPROUTBOAT_UWS_TARBALL
        ? `SPROUTBOAT_UWS_TARBALL=${archive} does not exist`
        : `no vendored uWebSockets archive at ${archive} (porffor pin moved? run \`bun tools/prebuild-uws.ts\`)`,
    );
  }
  if (!process.env.SPROUTBOAT_UWS_TARBALL) {
    const actual = await sha256File(archive);
    if (actual !== UWS_TARBALL_SHA256) {
      throw new UwsUnavailableError(
        `vendored uWebSockets sha256 mismatch\n  expected ${UWS_TARBALL_SHA256}\n  got      ${actual}`,
      );
    }
  }

  await extractUws(archive, dir);
}

/** Unpack the vendored source tree into `dir`. */
async function extractUws(archive: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // External programs cannot read Bun's virtual /$bunfs paths. Materialize the
  // embedded release asset inside the destination before handing it to tar.
  const readableArchive = archive.includes("/$bunfs/") ? resolve(dir, ".sproutboat-uwebsockets.tar.xz") : archive;
  if (readableArchive !== archive) await Bun.write(readableArchive, Bun.file(archive));
  const untar = Bun.spawn(["tar", "-xJf", readableArchive, "-C", dir, "--strip-components=1"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([untar.exited, new Response(untar.stderr).text()]);
  if (readableArchive !== archive) await rm(readableArchive, { force: true });
  if (code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new UwsUnavailableError(`could not extract vendored uWebSockets: ${err.trim()}`);
  }
}

/**
 * The same seeding for a **host** build (`dev`, `build --target host`,
 * `--standalone` on this machine).
 *
 * The vendored archive is a full checkout, so the sources are the same for
 * every target; only `uSockets.a` is target-specific. Porffor would build that
 * with `make -C uSockets`, which is where the `git` and `make` requirements on
 * a first build came from. Compiling the thirteen C files directly removes
 * both, and adds no new dependency: a host build already needs a C compiler,
 * because that is what Porffor compiles its own generated C with.
 *
 * Flags mirror the uSockets makefile's default target with the WITH_* switches
 * Porffor passes (all off): `-std=c11 -Isrc -DLIBUS_NO_SSL -flto -O3`, then
 * `ar rvs`. Nothing here is a judgement call; it is that recipe.
 */
export async function ensureUWebSocketsHost(): Promise<void> {
  const commit = uwsCommitFull();
  const dir = resolve(homedir(), ".cache/porffor/deps", `uWebSockets-${commit}`);
  const uSockets = resolve(dir, "uSockets");
  const archivePath = resolve(uSockets, "uSockets.a");
  if (existsSync(resolve(dir, "src/App.h")) && existsSync(archivePath)) return;

  const vendored = process.env.SPROUTBOAT_UWS_TARBALL || uwsVendorArchive(commit.slice(0, 8));
  if (!existsSync(vendored)) {
    throw new UwsUnavailableError(`no vendored uWebSockets archive at ${vendored}`);
  }
  if (!process.env.SPROUTBOAT_UWS_TARBALL) {
    const actual = await sha256File(vendored);
    if (actual !== UWS_TARBALL_SHA256) {
      throw new UwsUnavailableError(
        `vendored uWebSockets sha256 mismatch\n  expected ${UWS_TARBALL_SHA256}\n  got      ${actual}`,
      );
    }
  }
  if (!existsSync(resolve(dir, "src/App.h"))) await extractUws(vendored, dir);

  // The archive carries the musl-built uSockets.a. Linking that into a host
  // binary fails in a way nobody would connect to this, so it goes first.
  await rm(archivePath, { force: true });

  const sources = ["src/*.c", "src/eventing/*.c", "src/crypto/*.c", "src/io_uring/*.c"];
  const cc = process.env.CC || "cc";
  const ar = process.env.AR || "ar";
  const compile = Bun.spawn(["sh", "-c", `${cc} -std=c11 -Isrc -DLIBUS_NO_SSL -flto -O3 -c ${sources.join(" ")}`], {
    cwd: uSockets,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [ccCode, ccErr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  if (ccCode !== 0) {
    throw new UwsUnavailableError(
      `could not compile uSockets with ${cc}: ${ccErr.trim().split("\n").slice(-3).join(" ")}`,
    );
  }

  const archiveStep = Bun.spawn(["sh", "-c", `${ar} rvs uSockets.a *.o`], {
    cwd: uSockets,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [arCode, arErr] = await Promise.all([archiveStep.exited, new Response(archiveStep.stderr).text()]);
  if (arCode !== 0 || !existsSync(archivePath)) {
    throw new UwsUnavailableError(`could not archive uSockets with ${ar}: ${arErr.trim()}`);
  }
}

/** Directory holding node_modules/porffor (walks up from this file). */
export function porfforRoot(start = import.meta.dir): string {
  const managed = cachedPorfforRoot();
  if (existsSync(resolve(managed, "runtime/index.js"))) return managed;
  let dir = start;
  for (;;) {
    const candidate = resolve(dir, "node_modules/porffor");
    if (existsSync(resolve(candidate, "runtime/index.js"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return managed;
    dir = parent;
  }
}

export function porfforVersion(): string {
  if (process.env.PORFFOR_VERSION) return process.env.PORFFOR_VERSION;
  return `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}

export function esbuildVersion(): string {
  try {
    const pkg = Bun.resolveSync("esbuild/package.json", import.meta.dir);
    // SAFETY: esbuild's package.json always has a string `version`; defaulted below.
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: string };
    return parsed.version || "unknown";
  } catch {
    return "unknown";
  }
}

function uwsCommit(): string {
  try {
    const src = readFileSync(resolve(porfforRoot(), "compiler/uwebsockets.js"), "utf8");
    return /UWS_COMMIT\s*=\s*['"]([0-9a-f]{7,40})/.exec(src)?.[1]?.slice(0, 8) || UWS_COMMIT;
  } catch {
    return UWS_COMMIT;
  }
}

/** Compact provenance string for the artifact manifest. */
export function toolchainStamp(): string {
  return `zig-musl/${ZIG_VERSION}+porffor/${PORFFOR_COMMIT}+uws/${uwsCommit()}`;
}
