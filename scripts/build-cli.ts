/** Build a release-layout executable. Run on each supported host in CI; npm's
 * tiny launcher chooses the matching bin/platform/<os>-<arch>/sproutboat. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!platform || !arch) throw new Error(`unsupported release host ${process.platform}/${process.arch}`);
const out = resolve(import.meta.dir, "..", "bin", "platform", `${platform}-${arch}`, "sproutboat");
await mkdir(resolve(out, ".."), { recursive: true });
// SAFETY: package.json is this release's manifest and npm requires its version.
const version = ((await Bun.file(resolve(import.meta.dir, "..", "package.json")).json()) as { version: string })
  .version;
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
