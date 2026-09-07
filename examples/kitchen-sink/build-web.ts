/**
 * Build the Astro UI in web/ so web/dist exists before the harness / serve
 * script publishes it as the asset bundle. `sproutboat build` itself only
 * copies the directory — your framework build runs first, same as Wrangler.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "web");

export function buildWebUi(): string {
  if (!existsSync(join(WEB, "node_modules"))) {
    console.log("installing web/ deps (one-time)…");
    const install = Bun.spawnSync(["bun", "install"], { cwd: WEB, stdout: "inherit", stderr: "inherit" });
    if (install.exitCode !== 0) throw new Error("`bun install` failed in web/");
  }
  console.log("building the Astro UI (web/)…");
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: WEB, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("`astro build` failed");
  // Every byte value catches UTF-8 decoding, replacement and truncation bugs.
  const binary = new Uint8Array(256);
  for (let index = 0; index < binary.length; index++) binary[index] = index;
  writeFileSync(join(WEB, "dist", "binary-fixture.bin"), binary);
  return join(WEB, "dist");
}
