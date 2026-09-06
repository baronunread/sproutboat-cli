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

/**
 * #15 — let the build add objects to the native-fetch link line.
 *
 * Porffor builds `linkArgs` as a fixed array, so an embedded backend that needs
 * SQLite compiled into the sprout has nowhere to put it. `CXX` is not a way in:
 * a musl (deploy) build overrides it outright. This splices one spread of
 * `SB_EXTRA_LINK` before `-lm`, which is inert unless the variable is set.
 *
 * Same shape as the $PORT patch above, and tracked in the same place — an
 * upstream hook for extra link arguments would remove it.
 */
const LINK_ANCHOR = "          uSocketsArchive,\n          '-lm'\n";
const LINK_INJECT =
  "          ...(process.env.SB_EXTRA_LINK ? process.env.SB_EXTRA_LINK.split(' ').filter(Boolean) : []),\n";
const LINK_MARKER = "SB_EXTRA_LINK";

let done = false;

async function patchLinkArgs(): Promise<void> {
  const file = resolve(porfforRoot(), "compiler/index.js");
  const src = await readFile(file, "utf8");
  if (src.includes(LINK_MARKER)) return;
  const at = src.indexOf(LINK_ANCHOR);
  if (at === -1) {
    throw new Error(
      `could not patch Porffor for extra link args: anchor not found in ${file}. ` +
        "Porffor's native-fetch link step changed — check patches/UPSTREAM.md.",
    );
  }
  await writeFile(file, src.slice(0, at) + LINK_INJECT + src.slice(at));
}

export async function ensurePorfforPatched(): Promise<void> {
  if (done) return;
  await patchLinkArgs();
  const file = resolve(porfforRoot(), "compiler/render.js");
  const src = await readFile(file, "utf8");
  if (src.includes(MARKER)) {
    done = true;
    return;
  }
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
