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

// Each edit below is independent and idempotent, with its own marker: a file
// patched by an older version of this file must still receive the newer edits.
const ANCHOR = "f64 porf_native_fetch_get_port(void) {\n";

/** Port from $PORT (the supervisor and `sproutboat dev` set it). */
const ENV_INJECT =
  '  const char* __sb_port = getenv("PORT");\n' +
  "  if (__sb_port && *__sb_port) { long __sb_v = strtol(__sb_port, NULL, 10); if (__sb_v > 0 && __sb_v < 65536) return (f64)__sb_v; }\n";
const ENV_MARKER = 'getenv("PORT")';

// #15 — no `--port` flag: Porffor's native-fetch entry point calls
// `porf_init(0, NULL)` (see porf_native_fetch_runtime_init in render.js), so a
// native-fetch binary never sees argv at all. A standalone binary takes its
// port and data directory from the environment instead, which is what systemd
// and docker set anyway. Worth an upstream note alongside the $PORT ask.

/**
 * #15 — let the build add objects to the native-fetch link line.
 *
 * Porffor builds `linkArgs` as a fixed array, so an embedded backend that needs
 * SQLite compiled into the sprout has nowhere to put it. `CXX` is not a way in:
 * a musl (deploy) build overrides it outright. This splices one spread of
 * `SB_EXTRA_LINK` before `-lm`, inert unless the variable is set.
 */
const LINK_ANCHOR = "          uSocketsArchive,\n          '-lm'\n";
const LINK_INJECT =
  "          ...(process.env.SB_EXTRA_LINK ? process.env.SB_EXTRA_LINK.split(' ').filter(Boolean) : []),\n";
const LINK_MARKER = "SB_EXTRA_LINK";

/**
 * #15 — and the same for the compile step, so the prelude's inline C can
 * `#include <bearssl.h>`. The link patch alone is not enough: Porffor compiles
 * the generated C from stdin with a fixed argument list, so there is otherwise
 * no way to add an include path.
 */
const CFLAGS_ANCHOR = "          '-xc', '-', '-c',\n";
const CFLAGS_INJECT =
  "          ...(process.env.SB_EXTRA_CFLAGS ? process.env.SB_EXTRA_CFLAGS.split(' ').filter(Boolean) : []),\n";
const CFLAGS_MARKER = "SB_EXTRA_CFLAGS";

let done = false;

async function patchCompilerArgs(): Promise<void> {
  const file = resolve(porfforRoot(), "compiler/index.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, what] of [
    [LINK_MARKER, LINK_ANCHOR, LINK_INJECT, "extra link args"],
    [CFLAGS_MARKER, CFLAGS_ANCHOR, CFLAGS_INJECT, "extra compiler flags"],
  ] as const) {
    if (src.includes(marker)) continue;
    const at = src.indexOf(anchor);
    if (at === -1) {
      throw new Error(
        `could not patch Porffor for ${what}: anchor not found in ${file}. ` +
          "Porffor's native-fetch build changed — check patches/UPSTREAM.md.",
      );
    }
    // After the anchor for cflags (the args follow it), before it for the link
    // line (the object list ends with it).
    src =
      marker === CFLAGS_MARKER
        ? src.slice(0, at + anchor.length) + inject + src.slice(at + anchor.length)
        : src.slice(0, at) + inject + src.slice(at);
    changed = true;
  }
  if (changed) await writeFile(file, src);
}

export async function ensurePorfforPatched(): Promise<void> {
  if (done) return;
  await patchCompilerArgs();
  const file = resolve(porfforRoot(), "compiler/render.js");
  const src = await readFile(file, "utf8");
  if (src.includes(ENV_MARKER)) {
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
  await writeFile(file, src.slice(0, anchorAt + ANCHOR.length) + ENV_INJECT + src.slice(anchorAt + ANCHOR.length));
  done = true;
}
