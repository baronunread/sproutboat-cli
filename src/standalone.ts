/**
 * #15 — where a standalone binary keeps its data.
 *
 * A deployed sprout is stateless: every store lives on the node, addressed by
 * account-level resource ids the control plane provisions. A standalone binary
 * has no control plane and exactly one app, so it owns its data directly — and
 * the layout is the one decision that is painful to change later, because it is
 * the thing users copy, back up, and mount.
 *
 * Layout (deliberately identical to what `sproutboat dev` already writes, so the
 * embedded backend and the broker backend read the same files and the
 * conformance suite means something):
 *
 *     <name>.data/
 *       store.sqlite          kv · r2 · mq · do_storage · do_alarm · ae
 *       d1/<binding>.sqlite   one file per D1 database
 *
 * D1 is separate on purpose and must stay that way: it hands the handler
 * arbitrary SQL, so a `CREATE TABLE kv (...)` in user code would otherwise
 * collide with the platform's own tables in the same file.
 *
 * `resources/` from the server layout has no standalone equivalent — account
 * level resource ids are a control-plane concept, and with one app per binary
 * every binding takes the bare-name path.
 */
import { isAbsolute, resolve } from "node:path";

export type StorePaths = {
  /** The directory itself. Created on first run; safe to copy, delete or mount. */
  dataDir: string;
  /** Everything the platform owns, in one file. WAL adds -wal/-shm beside it. */
  storePath: string;
  /** Parent of the per-database D1 files. */
  d1Dir: string;
};

/**
 * Resolve where this app's data lives, most explicit wins:
 *
 *   1. `--data <dir>` on the command line
 *   2. `SPROUTBOAT_DATA` in the environment
 *   3. `./<name>.data` relative to the **working directory**
 *
 * Working directory rather than "beside the executable": the two are the same
 * for the common `./app` case, but cwd still behaves when the binary sits on
 * `$PATH` or on a read-only mount, it is what systemd's `WorkingDirectory`
 * controls, and it costs no `/proc/self/exe` lookup that would not port to
 * macOS anyway.
 */
export function resolveStorePaths(
  appName: string,
  options: { flag?: string | null; env?: string | null; cwd?: string } = {},
): StorePaths {
  const cwd = options.cwd ?? process.cwd();
  const chosen = options.flag || options.env || `${appName}.data`;
  const dataDir = isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
  return { dataDir, storePath: resolve(dataDir, "store.sqlite"), d1Dir: resolve(dataDir, "d1") };
}
