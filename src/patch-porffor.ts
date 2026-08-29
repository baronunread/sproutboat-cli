/**
 * Applies the Sproutboat patch to the pinned Porffor (`github:CanadaHonk/porffor#alpha-4`).
 * The tag ships no package.json, so `bun patch` can't manage it — this runs from
 * `postinstall`. Idempotent: skips a file that already contains the patch marker.
 *
 * Patch: compiler/render.js — honour $PORT at runtime in the native-fetch server.
 * The missing-polyfill gaps (URLSearchParams / Response.json / crypto) are handled
 * in src/native-fetch-prelude.js instead, not by patching Porffor.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Walk up from `start` until a directory contains `node_modules/porffor/`. */
function findPorffor(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = resolve(dir, "node_modules/porffor");
    if (existsSync(resolve(candidate, "compiler/render.js"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const porffor = findPorffor(import.meta.dir);
if (!porffor) {
  console.log("patch-porffor: node_modules/porffor not found — skipping");
  process.exit(0);
}

const file = resolve(porffor, "compiler/render.js");
const patch = resolve(import.meta.dir, "../patches/porffor-render.patch");
const marker = 'getenv("PORT")';

if ((await Bun.file(file).text()).includes(marker)) {
  console.log("patch-porffor: already patched");
} else {
  const child = Bun.spawn(["patch", "-s", "-p1", "-d", porffor, "-i", patch], { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    console.error(`patch-porffor: failed to apply ${patch}\n${err}`);
    process.exit(1);
  }
  console.log("patch-porffor: applied 1 patch");
}
