/** Build a release-layout executable. Run on each supported host in CI; npm's
 * tiny launcher chooses the matching bin/platform/<os>-<arch>/sproutboat. */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!platform || !arch) throw new Error(`unsupported release host ${process.platform}/${process.arch}`);
const out = resolve(import.meta.dir, "..", "bin", "platform", `${platform}-${arch}`, "sproutboat");
await mkdir(resolve(out, ".."), { recursive: true });
const child = Bun.spawn([process.execPath, "build", "--compile", "--target=bun", "--outfile", out, "src/main.ts"], {
  cwd: resolve(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit",
});
if ((await child.exited) !== 0) process.exit(1);
