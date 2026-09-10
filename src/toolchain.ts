/**
 * The build toolchain: a pinned Zig (the linux-x86_64 cross-compiler Porffor
 * shells out to for `--musl`) plus version stamps for the artifact manifest.
 *
 * Zig is fetched once to ~/.cache/sproutboat/zig-<version>/ and reused. No
 * Docker, no root. Override with SPROUTBOAT_ZIG=/path/to/zig.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
// @ts-expect-error Bun's file loader returns the embedded asset path in a compiled executable.
import embeddedUwsArchive from "../vendor/uwebsockets-360c276d-musl.tar.xz" with { type: "file" };
import { BEARSSL_VERSION } from "./bearssl";
import { cachedPorfforRoot, PORFFOR_CHANNEL, PORFFOR_COMMIT } from "./porffor-toolchain";
import { SQLITE_VERSION } from "./sqlite";

export const ZIG_VERSION = "0.16.0";

/** The `<arch>-<os>` platforms ziglang.org publishes a tarball for that we pin. */
export type ZigPlatform = "x86_64-linux" | "aarch64-linux" | "x86_64-macos" | "aarch64-macos";

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

export class ZigToolchainError extends Error {
  constructor(
    readonly kind: "download" | "integrity" | "archive" | "cache" | "compiler" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

export type EnsureZigOptions = {
  cacheRoot?: string;
  platform?: ZigPlatform;
  url?: string;
  expectedSha256?: string;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Test hook: release acquisition always validates the cross-C++ toolchain. */
  validate?: boolean;
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function zigComplete(dir: string, key: ZigPlatform, expectedArchive: string): Promise<boolean> {
  try {
    // SAFETY: this manifest is private data written below; its values are only
    // accepted when the immutable identity and binary digest both match.
    const manifest = JSON.parse(await readFile(resolve(dir, ".sproutboat-complete"), "utf8")) as {
      version?: string;
      platform?: string;
      archiveSha256?: string;
      binarySha256?: string;
      cValidated?: boolean;
    };
    const bin = resolve(dir, "zig");
    return (
      manifest.version === ZIG_VERSION &&
      manifest.platform === key &&
      manifest.archiveSha256 === expectedArchive &&
      manifest.binarySha256 !== undefined &&
      manifest.cValidated !== undefined &&
      (await sha256File(bin)) === manifest.binarySha256
    );
  } catch {
    return false;
  }
}

/** Confirm the downloaded compiler can produce the C target Sproutboat builds. */
async function validateZigTarget(bin: string, root: string): Promise<void> {
  const stage = resolve(root, `.zig-c-probe-${process.pid}-${crypto.randomUUID()}`);
  try {
    await mkdir(stage);
    const source = resolve(stage, "main.c");
    const out = resolve(stage, "probe");
    await writeFile(source, "int main() { return 0; }\n");
    const child = Bun.spawn([bin, "cc", "-target", "x86_64-linux-musl", "-static", source, "-o", out], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0 || !existsSync(out))
      throw new ZigToolchainError(
        "compiler",
        `pinned Zig cannot link a linux-x86_64-musl C binary: ${stderr.trim() || `exit ${code}`}\n` +
          "Set SPROUTBOAT_ZIG to a working Zig binary, then run `sproutboat toolchain doctor`.",
      );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function downloadZig(
  url: string,
  path: string,
  fetcher: NonNullable<EnsureZigOptions["fetcher"]>,
  timeoutMs: number,
): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(path, new Uint8Array(await response.arrayBuffer()));
      return;
    } catch (error) {
      last = error;
    }
  }
  throw new ZigToolchainError("download", `could not download pinned Zig from ${url}: ${String(last)}`);
}

async function waitForZigPublisher(
  dir: string,
  lock: string,
  key: ZigPlatform,
  expected: string,
): Promise<string | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await zigComplete(dir, key, expected)) return resolve(dir, "zig");
    if (!existsSync(lock)) return null;
    if (Date.now() - (await stat(lock)).mtimeMs > 5 * 60_000) {
      await rm(lock, { recursive: true, force: true });
      return null;
    }
    await Bun.sleep(25);
  }
  throw new ZigToolchainError("cache", `timed out waiting for Zig cache lock ${lock}`);
}

/** Absolute path to a verified Zig binary, downloading it on first use. */
export async function ensureZig(options: EnsureZigOptions = {}): Promise<string> {
  const override = process.env.SPROUTBOAT_ZIG;
  if (override) {
    if (!existsSync(override)) throw new ZigToolchainError("unsupported", `SPROUTBOAT_ZIG=${override} does not exist`);
    return override;
  }
  const key = options.platform ?? platformKey();
  const root = resolve(
    options.cacheRoot ?? process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? resolve(homedir(), ".cache/sproutboat"),
  );
  const dir = resolve(root, `zig-${ZIG_VERSION}-${key}`);
  const expected = options.expectedSha256 ?? ZIG_SHA256[key];
  if (await zigComplete(dir, key, expected)) return resolve(dir, "zig");
  await mkdir(root, { recursive: true });
  const lock = `${dir}.lock`;
  try {
    await mkdir(lock);
  } catch {
    const published = await waitForZigPublisher(dir, lock, key, expected);
    if (published) return published;
    return ensureZig(options);
  }
  const stage = resolve(root, `.zig-${ZIG_VERSION}-${key}-${process.pid}-${crypto.randomUUID()}`);
  const url = options.url ?? `https://ziglang.org/download/${ZIG_VERSION}/zig-${key}-${ZIG_VERSION}.tar.xz`;
  console.log(`Fetching Zig ${ZIG_VERSION} (${key}, one-time)...`);
  try {
    if (await zigComplete(dir, key, expected)) return resolve(dir, "zig");
    await rm(dir, { recursive: true, force: true });
    await mkdir(stage);
    const archive = resolve(stage, "zig.tar.xz");
    // Zig's pinned archive is about 50 MB. Keep the fetch bounded while
    // allowing a cold download to complete on ordinary consumer connections.
    await downloadZig(url, archive, options.fetcher ?? fetch, options.timeoutMs ?? 120_000);
    const actual = await sha256File(archive);
    if (actual !== expected)
      throw new ZigToolchainError(
        "integrity",
        `Zig archive sha256 mismatch\n  expected ${expected}\n  got      ${actual}`,
      );
    const untar = Bun.spawn(["tar", "-xJf", archive, "-C", stage, "--strip-components=1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([untar.exited, new Response(untar.stderr).text()]);
    if (code !== 0)
      throw new ZigToolchainError("archive", `could not extract Zig (needs \`tar\` with xz support): ${err.trim()}`);
    await rm(archive, { force: true });
    const bin = resolve(stage, "zig");
    if (!existsSync(bin)) throw new ZigToolchainError("archive", "Zig archive did not contain a `zig` binary");
    await chmod(bin, 0o755);
    if (options.validate !== false) await validateZigTarget(bin, root);
    await writeFile(
      resolve(stage, ".sproutboat-complete"),
      JSON.stringify({
        version: ZIG_VERSION,
        platform: key,
        archiveSha256: actual,
        binarySha256: await sha256File(bin),
        cValidated: options.validate !== false,
      }),
      { mode: 0o444 },
    );
    await rename(stage, dir);
    return resolve(dir, "zig");
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export type ToolchainDoctor = {
  host: `${string}/${string}`;
  cacheRoot: string;
  porffor: { version: string; path: string; override: string | null; present: boolean };
  zig: {
    version: string;
    platform: ZigPlatform | null;
    path: string | null;
    override: string | null;
    present: boolean;
  };
  sqlite: { version: string; path: string; present: boolean };
  bearssl: { version: string; path: string; present: boolean };
  prerequisites: { cc: string | null; ar: string | null; tar: string | null; xcrun: string | null; sdk: string | null };
};

/** Inspect the selected toolchain without downloading, compiling, or mutating a cache. */
export function inspectToolchain(): ToolchainDoctor {
  const cacheRoot = resolve(process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? resolve(homedir(), ".cache/sproutboat"));
  const porfforOverride = process.env.SPROUTBOAT_PORFFOR_DIR ? resolve(process.env.SPROUTBOAT_PORFFOR_DIR) : null;
  const zigOverride = process.env.SPROUTBOAT_ZIG ? resolve(process.env.SPROUTBOAT_ZIG) : null;
  let platform: ZigPlatform | null = null;
  try {
    platform = platformKey();
  } catch {
    /* doctor reports an unsupported host instead of throwing before its diagnostics */
  }
  const zigPath = zigOverride ?? (platform ? resolve(cacheRoot, `zig-${ZIG_VERSION}-${platform}`, "zig") : null);
  const porfforPath = porfforOverride ?? cachedPorfforRoot(cacheRoot);
  const sqlitePath = resolve(cacheRoot, `sqlite-${SQLITE_VERSION}`);
  const bearsslPath = resolve(cacheRoot, `bearssl-${BEARSSL_VERSION}`);
  const xcrun = process.platform === "darwin" ? Bun.which("xcrun") : null;
  const sdk = (() => {
    if (!xcrun) return null;
    const probe = Bun.spawnSync([xcrun, "--show-sdk-path"], { stdout: "pipe", stderr: "ignore" });
    return probe.exitCode === 0 ? probe.stdout.toString().trim() || null : null;
  })();
  return {
    host: `${process.arch}/${process.platform}`,
    cacheRoot,
    porffor: {
      version: porfforVersion(),
      path: porfforPath,
      override: porfforOverride,
      present: existsSync(resolve(porfforPath, "runtime/index.js")),
    },
    zig: {
      version: ZIG_VERSION,
      platform,
      path: zigPath,
      override: zigOverride,
      present: Boolean(zigPath && existsSync(zigPath)),
    },
    sqlite: { version: SQLITE_VERSION, path: sqlitePath, present: existsSync(sqlitePath) },
    bearssl: { version: BEARSSL_VERSION, path: bearsslPath, present: existsSync(bearsslPath) },
    prerequisites: {
      cc: Bun.which(process.env.CC ?? "cc"),
      ar: Bun.which(process.env.AR ?? "ar"),
      tar: Bun.which("tar"),
      xcrun,
      sdk,
    },
  };
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

const UWS_REQUIRED = ["src/App.h", "uSockets/uSockets.a"];

async function uwsComplete(dir: string, command?: string[]): Promise<boolean> {
  try {
    // SAFETY: this manifest is private data written below. The files it names
    // are fixed by this module and each recorded digest is recomputed.
    const manifest = JSON.parse(await readFile(resolve(dir, ".sproutboat-complete"), "utf8")) as {
      files?: Record<string, string>;
      command?: string[];
    };
    return (
      (command === undefined || JSON.stringify(manifest.command) === JSON.stringify(command)) &&
      (
        await Promise.all(
          UWS_REQUIRED.map(async (file) => (await sha256File(resolve(dir, file))) === manifest.files?.[file]),
        )
      ).every(Boolean)
    );
  } catch {
    return false;
  }
}

async function writeUwsManifest(dir: string, command?: string[]): Promise<void> {
  const files = Object.fromEntries(
    await Promise.all(UWS_REQUIRED.map(async (file) => [file, await sha256File(resolve(dir, file))] as const)),
  );
  const manifest = resolve(dir, ".sproutboat-complete");
  const stage = `${manifest}.${process.pid}.${crypto.randomUUID()}`;
  await writeFile(stage, JSON.stringify({ files, command }), { mode: 0o444 });
  await rename(stage, manifest);
}

/** Serialize cache reconstruction and recover a lock left by an interrupted build. */
async function withUwsLock<T>(dir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(dir), { recursive: true });
  const lock = `${dir}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      if (Date.now() > deadline) throw new UwsUnavailableError(`timed out waiting for uWebSockets cache lock ${lock}`);
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 5 * 60_000) await rm(lock, { recursive: true, force: true });
      } catch {
        /* the active publisher released the lock between stat and rm */
      }
      await Bun.sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
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
  if (await uwsComplete(dir)) return;

  await withUwsLock(dir, async () => {
    if (await uwsComplete(dir)) return;
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
  });
}

/** Unpack the vendored source tree into `dir`. */
async function extractUws(archive: string, dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
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
  try {
    await writeUwsManifest(dir);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new UwsUnavailableError(`could not validate vendored uWebSockets: ${String(error)}`);
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
  const cc = process.env.CC || "cc";
  const ar = process.env.AR || "ar";
  const command = [cc, ar];
  if (await uwsComplete(dir, command)) return;

  await withUwsLock(dir, async () => {
    if (await uwsComplete(dir, command)) return;
    const vendored = process.env.SPROUTBOAT_UWS_TARBALL || uwsVendorArchive(commit.slice(0, 8));
    if (!existsSync(vendored)) throw new UwsUnavailableError(`no vendored uWebSockets archive at ${vendored}`);
    if (!process.env.SPROUTBOAT_UWS_TARBALL) {
      const actual = await sha256File(vendored);
      if (actual !== UWS_TARBALL_SHA256) {
        throw new UwsUnavailableError(
          `vendored uWebSockets sha256 mismatch\n  expected ${UWS_TARBALL_SHA256}\n  got      ${actual}`,
        );
      }
    }
    await extractUws(vendored, dir);

    // The archive carries the musl-built uSockets.a. Linking that into a host
    // binary fails in a way nobody would connect to this, so it goes first.
    await rm(archivePath, { force: true });

    const sources = ["src/*.c", "src/eventing/*.c", "src/crypto/*.c", "src/io_uring/*.c"];
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
    await writeUwsManifest(dir, command);
  });
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
