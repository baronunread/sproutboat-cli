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

export const ZIG_VERSION = "0.16.0";

// sha256 of the official ziglang.org tarballs for ZIG_VERSION, keyed by
// `<arch>-<os>` (the download naming). Bump alongside ZIG_VERSION.
const ZIG_SHA256: Record<string, string> = {
  "x86_64-linux": "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
  "aarch64-linux": "ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17",
  "x86_64-macos": "0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7",
  "aarch64-macos": "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
};

// Pinned Porffor identity — must match the `porffor` entry in package.json
// (`github:CanadaHonk/porffor#alpha-4`, commit a415d19). PORFFOR_VERSION overrides.
const PORFFOR_CHANNEL = "alpha-4";
const PORFFOR_COMMIT = "a415d19";

// uWebSockets commit Porffor alpha-4 fetches for the native-fetch server. Read
// from node_modules/porffor at build time; this is the fallback for the stamp.
const UWS_COMMIT = "360c276d";

function platformKey(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : null;
  if (!arch || !os) throw new Error(`no pinned Zig for ${process.platform}/${process.arch} — set SPROUTBOAT_ZIG to a zig ${ZIG_VERSION} binary`);
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
  const untar = Bun.spawn(["tar", "-xJf", archive, "-C", dir, "--strip-components=1"], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([untar.exited, new Response(untar.stderr).text()]);
  if (code !== 0) throw new Error(`could not extract Zig (needs \`tar\` with xz support): ${err.trim()}`);
  await rm(archive, { force: true });
  if (!existsSync(bin)) throw new Error("Zig archive did not contain a `zig` binary");
  await chmod(bin, 0o755);
  return bin;
}

/** Directory holding node_modules/porffor (walks up from this file). */
export function porfforRoot(start = import.meta.dir): string {
  let dir = start;
  for (;;) {
    const candidate = resolve(dir, "node_modules/porffor");
    if (existsSync(resolve(candidate, "runtime/index.js"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("node_modules/porffor not found — run `bun install`");
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
