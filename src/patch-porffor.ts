/**
 * Make Porffor's generated native-fetch server read its listen port from $PORT
 * at runtime (falling back to the compiled `port:` value). Porffor renders the
 * server as C text in `compiler/render.js`; we splice two lines into
 * `porf_native_fetch_get_port()`.
 *
 * Done as an idempotent in-place edit rather than a `postinstall` hook: package
 * managers block dependency lifecycle scripts by default, so a published
 * `postinstall` would silently not run. This is called from the build path
 * instead, where it always runs.
 *
 * Tracked upstream in patches/UPSTREAM.md — once Porffor reads $PORT (or exposes
 * env to handlers) this whole file goes away.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { porfforRoot } from "./toolchain";

// Splice INJECT in immediately after the opening brace, before the return.
const ANCHOR = "f64 porf_native_fetch_get_port(void) {\n";
const INJECT =
  '  const char* __sb_port = getenv("PORT");\n' +
  "  if (__sb_port && *__sb_port) { long __sb_v = strtol(__sb_port, NULL, 10); if (__sb_v > 0 && __sb_v < 65536) return (f64)__sb_v; }\n";
const MARKER = 'getenv("PORT")';

let done = false;

export async function ensurePorfforPatched(): Promise<void> {
  if (done) return;
  const file = resolve(porfforRoot(), "compiler/render.js");
  const src = await readFile(file, "utf8");
  if (src.includes(MARKER)) { done = true; return; }
  const anchorAt = src.indexOf(ANCHOR);
  if (anchorAt === -1) {
    throw new Error(
      `could not patch Porffor for $PORT: anchor not found in ${file}. ` +
      "Porffor's native-fetch renderer changed — check patches/UPSTREAM.md.",
    );
  }
  const patched = src.slice(0, anchorAt + ANCHOR.length) + INJECT + src.slice(anchorAt + ANCHOR.length);
  await writeFile(file, patched);
  done = true;
}
