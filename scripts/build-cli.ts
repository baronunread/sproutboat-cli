/** Build one platform package executable. npm's tiny root launcher resolves it. */
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!platform || !arch) throw new Error(`unsupported release host ${process.platform}/${process.arch}`);
const packageDir = resolve(import.meta.dir, "..", "platform-packages", `${platform}-${arch}`);
const out = resolve(packageDir, "bin", "sproutboat");
await mkdir(resolve(out, ".."), { recursive: true });
// SAFETY: package.json is this release's manifest and npm requires its version.
const version = ((await Bun.file(resolve(import.meta.dir, "..", "package.json")).json()) as { version: string })
  .version;
// SAFETY: every checked-in platform package manifest owns a required string version.
const platformVersion = ((await Bun.file(resolve(packageDir, "package.json")).json()) as { version: string }).version;
if (platformVersion !== version)
  throw new Error(`platform package version ${platformVersion} does not match root ${version}`);
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "--compile",
    "--target=bun",
    `--define:process.env.SPROUTBOAT_CLI_VERSION=${JSON.stringify(version)}`,
    "--outfile",
    out,
    "src/main.ts",
  ],
  {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await child.exited) !== 0) process.exit(1);
let esbuild: string;
try {
  esbuild = Bun.resolveSync(`@esbuild/${platform}-${arch}/bin/esbuild`, import.meta.dir);
} catch {
  throw new Error("matching esbuild binary is missing; run bun install before building a platform package");
}
const packagedEsbuild = resolve(packageDir, "bin", "esbuild");
await copyFile(esbuild, packagedEsbuild);
await copyFile(resolve(import.meta.dir, "..", "THIRD_PARTY_NOTICES.md"), resolve(packageDir, "THIRD_PARTY_NOTICES.md"));
await chmod(packagedEsbuild, 0o755);
