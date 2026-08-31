#!/usr/bin/env bun
/**
 * Produce `uwebsockets-<short>-musl.tar.xz`: the checked-out, patched, and
 * `zig cc -target x86_64-linux-musl`-built uWebSockets tree that Porffor links
 * for the native-fetch server (headers + `uSockets/uSockets.a`).
 *
 * It ships in the package under `vendor/`; `src/toolchain.ts` `ensureUWebSockets()`
 * extracts it so a user's first build needs no `git` / `make`. Run this whenever
 * the `porffor` pin (and thus its uWebSockets commit) changes:
 *
 *   bun tools/prebuild-uws.ts
 *
 * then paste the printed sha256 into `UWS_TARBALL_SHA256` and commit `vendor/`.
 * CI does it for you — see .github/workflows/uws-prebuild.yml.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileWorker } from "../src/compile";
import { ensureZig } from "../src/toolchain";

const uwsJs = resolve(import.meta.dir, "../node_modules/porffor/compiler/uwebsockets.js");
const commit = /UWS_COMMIT\s*=\s*['"]([0-9a-f]{40})/.exec(readFileSync(uwsJs, "utf8"))?.[1];
if (!commit) throw new Error(`could not read UWS_COMMIT from ${uwsJs} — is porffor installed?`);
const short = commit.slice(0, 8);

const depsRoot = resolve(homedir(), ".cache/porffor/deps");
const cacheDir = resolve(depsRoot, `uWebSockets-${commit}-musl`);
const seeded = existsSync(resolve(cacheDir, "src/App.h")) && existsSync(resolve(cacheDir, "uSockets/uSockets.a"));

if (seeded) {
  console.log(`uWebSockets cache already present at ${cacheDir}`);
} else {
  console.log(`Building uWebSockets @ ${short} for x86_64-linux-musl (git + make + zig, one-time)...`);
  // A throwaway compile populates the cache via Porffor's git+make fallback.
  delete process.env.SPROUTBOAT_UWS_TARBALL;
  const work = await mkdtemp(resolve(tmpdir(), "uws-prebuild-"));
  await Bun.write(resolve(work, "h.js"), 'export default { fetch() { return new Response("ok"); } };');
  await compileWorker({ sourcePath: resolve(work, "h.js"), outPath: resolve(work, "worker"), vars: {}, zigBin: await ensureZig() });
}

const vendorDir = resolve(import.meta.dir, "../vendor");
Bun.spawnSync(["mkdir", "-p", vendorDir]);
const archive = resolve(vendorDir, `uwebsockets-${short}-musl.tar.xz`);
const tar = Bun.spawnSync(
  ["tar", "--exclude=.git", "-cJf", archive, "-C", depsRoot, `uWebSockets-${commit}-musl`],
  { stdout: "inherit", stderr: "inherit" },
);
if (tar.exitCode !== 0) throw new Error("tar failed");

const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
console.log(`
  archive : vendor/uwebsockets-${short}-musl.tar.xz
  sha256  : ${sha}

Next:
  1. set UWS_TARBALL_SHA256 = "${sha}" in src/toolchain.ts
  2. rm any stale vendor/uwebsockets-*-musl.tar.xz for old commits
  3. git add vendor/ src/toolchain.ts && commit
`);
