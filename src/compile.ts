/**
 * Compile `export default { fetch }` into a linux-x86_64 native-fetch server
 * binary. Porffor renders the handler to C; with `--musl` it cross-compiles via
 * `zig cc -target x86_64-linux-musl` and statically links, so the same command
 * works from macOS, Linux, or WSL with no Docker.
 *
 * One-time per machine: the uWebSockets tree Porffor links is unpacked into
 * ~/.cache/porffor/deps/. `ensureUWebSockets()` extracts the prebuilt archive
 * shipped in `vendor/` so this needs no `git` or `make`; if that archive is
 * unusable it falls back to Porffor's own git + make path (needs both on PATH).
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensurePorfforPatched } from "./patch-porffor";
import { ensureUWebSockets, porfforRoot, UwsUnavailableError } from "./toolchain";
import { EMPTY_BINDINGS, preludePath, wrapNativeFetchHandler, type Bindings } from "./wrap";

export { EMPTY_BINDINGS, preludePath, wrapNativeFetchHandler, type Bindings } from "./wrap";

const COMPILE_TIMEOUT_MS = Number(process.env.SPROUTBOAT_COMPILE_TIMEOUT_MS || 600_000);

export type CompileInput = {
  sourcePath: string;
  /** The bundled module (#89). Falls back to reading `sourcePath` verbatim. */
  source?: string;
  outPath: string;
  vars: Record<string, string>;
  bindings?: Bindings;
  /** Cross-compiler for `linux-x86_64`. Not needed, and not used, for `host`. */
  zigBin?: string;
  /**
   * `linux-x86_64` (default) cross-compiles the static musl binary every box
   * runs. `host` compiles for the machine doing the build (#62) so `sproutboat
   * dev` can actually serve a sprout on a developer's laptop — an arm64 Mac
   * cannot execute the deploy artifact.
   */
  target?: "linux-x86_64" | "host";
};

/** Compile `sourcePath` to a native binary at `outPath` (mode 0555). */
export async function compileSprout(input: CompileInput): Promise<void> {
  await ensurePorfforPatched();

  // Seed the Porffor uWebSockets cache from the prebuilt archive in `vendor/` so
  // the first build needs no `git` / `make`. Fall back to Porffor's own git+make
  // path if the archive is missing or fails its checksum.
  try {
    await ensureUWebSockets();
  } catch (error) {
    if (!(error instanceof UwsUnavailableError)) throw error;
    const haveGit = Bun.which("git");
    const haveMake = Bun.which("make");
    if (haveGit && haveMake) {
      console.warn(`prebuilt uWebSockets unusable (${error.message.split("\n")[0]}); falling back to git + make (slower, one-time)`);
    } else {
      const missing = [!haveGit && "git", !haveMake && "make"].filter(Boolean).join(" and ");
      throw new Error(
        `${error.message}\n\nThe prebuilt uWebSockets is unusable, and ${missing} ` +
        `${missing.includes("and") ? "are" : "is"} not on PATH for the fallback build. ` +
        `Install ${missing}, or set SPROUTBOAT_UWS_TARBALL to a valid archive.`,
      );
    }
  }

  const outDir = dirname(input.outPath);
  await mkdir(outDir, { recursive: true });
  // The artifact dir is content-addressed, so rebuilding unchanged source lands
  // on the previous binary — which `chmod 0555` left read-only, and which the
  // OS may still be executing. The linker cannot overwrite either, so clear it
  // first rather than failing with "can't write output file".
  await rm(input.outPath, { force: true });
  const generatedPath = resolve(outDir, "sprout.generated.js");
  const [source, prelude] = await Promise.all([
    input.source === undefined ? readFile(input.sourcePath, "utf8") : Promise.resolve(input.source),
    readFile(preludePath, "utf8"),
  ]);
  await writeFile(generatedPath, wrapNativeFetchHandler(source, prelude, input.vars, input.bindings ?? EMPTY_BINDINGS));

  const porffor = porfforRoot();
  const launcher = resolve(porffor, "runtime/index.js");
  // Porffor shells bare `zig` and `esbuild`; put both on PATH for the child.
  // A host build never shells `zig`, so it has no zigBin to contribute.
  const binDir = resolve(porffor, "../.bin");
  const zigDir = input.zigBin ? `${dirname(input.zigBin)}:` : "";
  const path = `${zigDir}${binDir}:${process.env.PATH ?? ""}`;

  // `-s`: strip at link. The unstripped static-musl binary is ~90% DWARF that
  // nothing needs at runtime (12 MB -> ~1.3 MB for the kitchen-sink). Porffor
  // forwards `-s` straight to the `zig cc` link step.
  // `--musl` is what makes it a cross-compile; a host build simply omits it and
  // Porffor targets the machine it is running on.
  const crossFlags = input.target === "host" ? [] : ["--musl"];
  const child = Bun.spawn(
    [process.execPath, launcher, "native", generatedPath, "-o", input.outPath, ...crossFlags, "-s"],
    { cwd: outDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: path } },
  );
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, COMPILE_TIMEOUT_MS);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);

  if (timedOut) throw new Error(`compile timed out after ${COMPILE_TIMEOUT_MS}ms`);
  if (code !== 0 || !(await Bun.file(input.outPath).exists())) {
    throw new Error(`Porffor compile failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  }
  await chmod(input.outPath, 0o555);
}
