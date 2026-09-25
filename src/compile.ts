/**
 * Compile `export default { fetch }` into a linux-x86_64 native-fetch server
 * binary. Porffor renders the handler to C; with `--musl` it cross-compiles via
 * `zig cc -target x86_64-linux-musl` and statically links, so the same command
 * works from macOS, Linux, or WSL with no Docker.
 *
 * One-time per machine: the uWebSockets tree Porffor links is unpacked into
 * ~/.cache/porffor/deps/. `ensureUWebSockets()` extracts the prebuilt archive
 * shipped in `vendor/` so this needs no `git` or `make`; if that archive is
 * unusable it stops with its specific integrity or archive error. Contributors
 * may explicitly opt into Porffor's source fallback.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensurePorfforPatched } from "./patch-porffor";
import { ensureUWebSockets, ensureUWebSocketsHost, resolveHostCompiler, UwsUnavailableError } from "./toolchain";
import { ensurePorffor } from "./porffor-toolchain";
// The prelude + transports live in @sproutboat/runtime (next to wrap.ts, which
// locates them by file URL). `preludePath`/`transportPath` read them from there
// for a dev build; these text imports bake the same files into the `--compile`
// binary, where there is no filesystem to read.
// @ts-expect-error Bun's text loader supplies a string, while TypeScript resolves the JavaScript source itself.
import embeddedPrelude from "@sproutboat/runtime/src/native-fetch-prelude.js" with { type: "text" };
// @ts-expect-error See above.
import embeddedBrokerTransport from "@sproutboat/runtime/src/transport-broker.js" with { type: "text" };
// @ts-expect-error See above.
import embeddedStandaloneTransport from "@sproutboat/runtime/src/transport-embedded.js" with { type: "text" };
import {
  EMPTY_BINDINGS,
  preludePath,
  transportPath,
  wrapNativeFetchHandler,
  TRANSPORT_MARKER,
  type Bindings,
  type Transport,
} from "./wrap";
const PACKAGED = import.meta.url.includes("/$bunfs/");
export type { Transport } from "./wrap";

export {
  BASELINE_COMPATIBILITY_DATE,
  EMPTY_BINDINGS,
  preludePath,
  wrapNativeFetchHandler,
  type Bindings,
} from "./wrap";

const COMPILE_TIMEOUT_MS = Number(process.env.SPROUTBOAT_COMPILE_TIMEOUT_MS || 600_000);

export type CompileInput = {
  sourcePath: string;
  /** Stable compiler input for dev rebuilds, independent of the candidate binary path. */
  generatedPath?: string;
  /** The bundled module (#89). Falls back to reading `sourcePath` verbatim. */
  source?: string;
  /** The exact wrapped module used to compute a verified compile-cache key. */
  generatedSource?: string;
  outPath: string;
  vars: Record<string, string>;
  bindings?: Bindings;
  /** The project's `compatibility_date`, baked in so the runtime can gate a
   *  behaviour change on it. Defaults to the baseline when absent. */
  compatibilityDate?: string;
  /** #15 — which `__sbCall` to compile in. Defaults to the broker transport. */
  transport?: Transport;
  /** #15 — the project name, baked so an embedded build can default its data dir. */
  appName?: string;
  /** #15 — assets baked into the module (embedded builds have no files on disk). */
  assets?: { manifest: unknown; files: Record<string, string> };
  /** #15 — objects to add to the native-fetch link line (SQLite, BearSSL). */
  extraLink?: string[];
  /** #15 — flags for the compile step, so inline C can include BearSSL's header. */
  extraCflags?: string[];
  /**
   * How hard the C compiler works on the generated code.
   *
   * Porffor defaults to `-O3` (compiler/index.js reads `-O` from its own argv),
   * which costs most of the build: `examples/hello` is 8.4s at -O3 against 2.9s
   * at -O0 on an M-series host. `dev` pays that on every edit for a binary that
   * never leaves the machine, so it compiles at -O0 and takes a ~55% larger
   * file. Anything that could be deployed stays at -O3.
   */
  optimize?: "dev" | "release";
  /** Cross-compiler for `linux-x86_64`. Not needed, and not used, for `host`. */
  zigBin?: string;
  /** #126 — `env.<binding> = { id, tag, timestamp }`, baked directly into the module. */
  versionMetadata?: { binding: string; id: string; tag: string; timestamp: string };
  /**
   * `linux-x86_64` (default) cross-compiles the static musl binary every box
   * runs. `host` compiles for the machine doing the build (#62) so `sproutboat
   * dev` can actually serve a sprout on a developer's laptop — an arm64 Mac
   * cannot execute the deploy artifact.
   */
  target?: "linux-x86_64" | "host";
};

/**
 * The prelude with a transport spliced in — the exact text the compiler sees.
 *
 * Exported because more than one caller composes a sprout: the build, and the
 * kitchen-sink harness that compiles one itself. Reading
 * `native-fetch-prelude.js` alone yields a module with no `__sbCall` at all.
 */
export async function loadPrelude(transport: Transport = "broker"): Promise<string> {
  const [core, chosen] = PACKAGED
    ? [embeddedPrelude, transport === "embedded" ? embeddedStandaloneTransport : embeddedBrokerTransport]
    : await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath(transport), "utf8")]);
  if (!core.includes(TRANSPORT_MARKER)) {
    throw new Error(
      "prelude is missing its transport marker — @sproutboat/runtime/src/native-fetch-prelude.js changed shape",
    );
  }
  return core.replace(TRANSPORT_MARKER, chosen);
}

/** Child env for the Porffor run. `SB_EXTRA_LINK` is read by the patched link
 *  step (#15) and is absent entirely for a normal build. `cc`/`cxx` override
 *  Porffor's own `CC`/`CXX` read for a **host** build (musl builds hardcode
 *  `zig cc` themselves and ignore both). */
function compileEnv(
  path: string,
  extraLink?: string[],
  extraCflags?: string[],
  compiler?: { cc: string[]; cxx: string[] },
) {
  const link = extraLink && extraLink.length > 0 ? extraLink.join(" ") : undefined;
  const cflags = extraCflags && extraCflags.length > 0 ? extraCflags.join(" ") : undefined;
  const env = { ...process.env, PATH: path, SB_EXTRA_LINK: link, SB_EXTRA_CFLAGS: cflags };
  if (compiler) return { ...env, CC: compiler.cc.join(" "), CXX: compiler.cxx.join(" ") };
  return env;
}

/**
 * The argument list handed to Porffor, minus the launcher.
 *
 * Exported for the test: the one thing worth pinning is that `-O0` reaches only
 * a build that cannot be deployed. `-s` strips at link, because the unstripped
 * static-musl binary is ~90% DWARF that nothing needs at runtime (12 MB down to
 * ~1.3 MB for the kitchen-sink). `--musl` is what makes it a cross-compile; a
 * host build omits it and Porffor targets the machine it runs on.
 */
export function porfforArgs(
  generatedPath: string,
  outPath: string,
  target: CompileInput["target"],
  optimize: CompileInput["optimize"],
  usingZig = false,
): string[] {
  const args = ["native", generatedPath, "-o", outPath];
  if (target !== "host") args.push("--musl");
  args.push("-s");
  // Porffor reads -O from its own argv and defaults to -O3. -O0 is roughly
  // three times faster to compile, so dev takes it and everything else does
  // not: a deployable artifact is never built with it.
  if (optimize === "dev" && target === "host") args.push("-O0");
  // Porffor defaults LTO on for a non-musl link. Zig's cc needs `-fuse-ld=lld`
  // wired up for that, which nothing here does, so turn it off rather than
  // fail every host build that falls back to Zig for its C toolchain.
  if (usingZig) args.push("--no-flto");
  return args;
}

/** Compile `sourcePath` to a native binary at `outPath` (mode 0555). */
export async function compileSprout(input: CompileInput): Promise<void> {
  const porffor = await ensurePorffor();
  await ensurePorfforPatched(porffor);

  // Seed the Porffor uWebSockets cache from the prebuilt archive in `vendor/` so
  // the first build needs no `git` / `make`. The two targets keep separate
  // cache trees and separate uSockets.a, so seed whichever this build wants.
  // Fall back to Porffor's own git+make path if the archive is unusable.
  try {
    if (input.target === "host") await ensureUWebSocketsHost();
    else await ensureUWebSockets();
  } catch (error) {
    if (!(error instanceof UwsUnavailableError)) throw error;
    if (process.env.SPROUTBOAT_BUILD_UWS_FROM_SOURCE !== "1") throw error;
    const haveGit = Bun.which("git");
    const haveMake = Bun.which("make");
    if (haveGit && haveMake) {
      console.warn(
        `prebuilt uWebSockets unusable (${error.message.split("\n")[0]}); explicit source build uses git + make`,
      );
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
  const generatedPath = input.generatedPath ?? resolve(outDir, "sprout.generated.js");
  await mkdir(dirname(generatedPath), { recursive: true });
  const generatedSource =
    input.generatedSource ??
    (await (async () => {
      const [source, prelude] = await Promise.all([
        input.source === undefined ? readFile(input.sourcePath, "utf8") : Promise.resolve(input.source),
        loadPrelude(input.transport ?? "broker"),
      ]);
      return wrapNativeFetchHandler(
        source,
        prelude,
        input.vars,
        input.bindings ?? EMPTY_BINDINGS,
        undefined,
        input.compatibilityDate,
        input.appName,
        input.assets,
        input.transport,
        input.versionMetadata,
      );
    })());
  await writeFile(generatedPath, generatedSource);

  const launcher = resolve(porffor, "runtime/index.js");
  // A musl build shells `zig` bare (Porffor hardcodes the literal command), so
  // it needs its dir on PATH; a host build passes its compiler via CC/CXX
  // below instead and has no zigBin to contribute here.
  const zigDir = input.zigBin ? `${dirname(input.zigBin)}:` : "";
  const hostCompiler = input.target === "host" ? await resolveHostCompiler() : undefined;
  const path = `${zigDir}${process.env.PATH ?? ""}`;
  const command = PACKAGED
    ? [process.execPath, "__porffor", launcher]
    : [process.execPath, resolve(import.meta.dir, "main.ts"), "__porffor", launcher];

  const child = Bun.spawn(
    [...command, ...porfforArgs(generatedPath, input.outPath, input.target, input.optimize, hostCompiler?.usingZig)],
    {
      cwd: outDir,
      stdout: "pipe",
      stderr: "pipe",
      env: compileEnv(path, input.extraLink, input.extraCflags, hostCompiler),
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, COMPILE_TIMEOUT_MS);
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
