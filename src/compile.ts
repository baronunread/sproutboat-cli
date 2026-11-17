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
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  ensureUWebSockets,
  ensureUWebSocketsHost,
  ensureUWebSocketsStandalone,
  resolveHostCompiler,
  uwsCommitFull,
  UwsUnavailableError,
} from "./toolchain";
import { linuxTriple, type BuildTarget } from "./targets";
import {
  buildStandaloneA21,
  composeStandaloneA21,
  ensurePorfforA21,
  SHARED_PRELUDE_FILE,
  STANDALONE_A21_COMPILE_FLAGS,
  standaloneA21Channel,
  standaloneChannel,
  type StandaloneChannel,
} from "@sproutboat/toolchain/a21";
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

/**
 * The Porffor channel a native compile uses: `alpha-25`, the toolchain's one alpha (the patched tree the
 * toolchain ships, composed in sproutd's worker shape and served by the toolchain's vendored uWebSockets shim
 * over its flat native-fetch bridge; sproutd-alpha22-standalone-port.md). The toolchain's `standaloneChannel()`
 * decides, so the CLI and the runtime's native tests agree. `SPROUTBOAT_PORFFOR_CHANNEL` may name `alpha-25`;
 * alpha 19, 21, 22 and 23 are errors that say they are no longer supported.
 */
export type PorfforChannel = StandaloneChannel;
export function porfforChannel(): PorfforChannel {
  return standaloneChannel();
}

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
  /** Link-time optimization on the alpha 22 standalone link; default on. See `BuildInput.lto`. */
  lto?: boolean;
  /** Cross-compiler for a Linux target. Not needed, and not used, for `host`. */
  zigBin?: string;
  /** #126 — `env.<binding> = { id, tag, timestamp }`, baked directly into the module. */
  versionMetadata?: { binding: string; id: string; tag: string; timestamp: string };
  /**
   * `linux-x86_64` (default) cross-compiles the static musl binary every box
   * runs. `host` compiles for the machine doing the build (#62) so `sproutboat
   * dev` can actually serve a sprout on a developer's laptop — an arm64 Mac
   * cannot execute the deploy artifact.
   */
  target?: BuildTarget;
  /**
   * Write `generatedPath` exactly as a full compile would, then stop: no
   * Porffor, no uWebSockets, no compiler, nothing at `outPath`. For callers
   * that need the wrapped module (prelude, bindings, handler) and never run the
   * binary, such as a qualification run that only inspects the source.
   */
  emitOnly?: boolean;
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

/**
 * Drop the previous render from a units directory, keeping `obj/`.
 *
 * The renderer rewrites every unit, and a unit whose name changed must not linger (the build compiles every
 * `.c` it finds). `obj/` holds the objects `buildStandaloneA21` stamps by the unit text, `porf.h` and the
 * flags, so it has to survive a rebuild: wiping it recompiled every unit on every build, which made a warm
 * host build as slow as a cold one (about 13 s of C compile plus the link).
 */
export async function clearRenderedUnits(unitsDir: string): Promise<void> {
  const entries = await readdir(unitsDir).catch((): string[] => []);
  await Promise.all(
    entries
      .filter((name) => name !== "obj")
      .map((name) => rm(resolve(unitsDir, name), { recursive: true, force: true })),
  );
}

let porfforBuildsPruned = false;
/**
 * Porffor writes one build dir per entry path under ~/.cache/porffor/build and
 * never removes any (one machine had 1,395 of them, 6.3 GB). Drop the ones not
 * compiled in for a week; the only cost is a recompile. Each dir's `flags`
 * stamp is rewritten on every compile, so its mtime is "last used".
 *
 * Age alone does not bound it: every dev session, temp-dir test and scratch
 * build is a new entry path, so another machine reached 923 dirs (10 GB) in
 * three days. Keep only the `keep` most recently used as well (~11 MB each).
 */
export async function prunePorfforBuilds(
  root = resolve(process.env.HOME ?? homedir(), ".cache/porffor/build"),
  now = Date.now(),
  keep = 100,
): Promise<number> {
  porfforBuildsPruned = true;
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const entries: string[] = await readdir(root).catch(() => []);
  const dirs: { dir: string; used: number }[] = [];
  for (const name of entries) {
    const dir = resolve(root, name);
    const used = (await stat(resolve(dir, "flags")).catch(() => null)) ?? (await stat(dir).catch(() => null));
    if (used) dirs.push({ dir, used: used.mtimeMs });
  }
  dirs.sort((a, b) => b.used - a.used);
  let removed = 0;
  for (const [index, { dir, used }] of dirs.entries()) {
    if (used < cutoff || index >= keep) {
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * The `-O` level of the C compile. `-O0` roughly triples build speed (8.4s -> 2.9s for examples/hello) and grows the
 * binary by about half, so it is for a host `dev` build only: what a user could ship is never built with it.
 */
export function optimizeLevel(optimize: CompileInput["optimize"], target: CompileInput["target"]): 0 | 3 {
  return optimize === "dev" && target === "host" ? 0 : 3;
}

/**
 * Whether the alpha 22 link runs LTO: `SPROUTBOAT_FLTO` wins, then an explicit `lto`, then on for everything
 * except a host `dev` build.
 */
export function ltoEnabled(input: { optimize?: "dev" | "release"; target?: string; lto?: boolean }): boolean {
  if (process.env.SPROUTBOAT_FLTO) return process.env.SPROUTBOAT_FLTO === "1";
  if (input.lto !== undefined) return input.lto;
  return !(input.optimize === "dev" && input.target === "host");
}

/** The wrapped module the compiler sees: `generatedSource` if given, else the source wrapped here. */
async function generateSource(input: CompileInput): Promise<string> {
  if (input.generatedSource !== undefined) return input.generatedSource;
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
}

/** Write the wrapped module to `generatedPath` (default: beside `outPath`) and return that path. */
async function writeGenerated(input: CompileInput): Promise<string> {
  const generatedPath = input.generatedPath ?? resolve(dirname(input.outPath), "sprout.generated.js");
  const generatedSource = await generateSource(input);
  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, generatedSource);
  return generatedPath;
}

/**
 * Compile `sourcePath` to a native binary at `outPath` (mode 0555).
 *
 * With `emitOnly`, write `generatedPath` and return before any of the native
 * compile's inputs are acquired. Generation needs only the runtime prelude and
 * the wrapper, never Porffor itself.
 */
export async function compileSprout(input: CompileInput): Promise<void> {
  if (input.emitOnly) {
    await writeGenerated(input);
    return;
  }
  // Seed the Porffor uWebSockets cache from the prebuilt archive in `vendor/` so
  // the first build needs no `git` / `make`. The two targets keep separate
  // cache trees and separate uSockets.a, so seed whichever this build wants.
  // Fall back to Porffor's own git+make path if the archive is unusable.
  let uwsVariant: string | undefined;
  try {
    if (input.target === "host") await ensureUWebSocketsHost();
    else if (input.transport === "embedded" && input.zigBin) {
      uwsVariant = await ensureUWebSocketsStandalone(input.target ?? "linux-x86_64", input.zigBin);
    } else await ensureUWebSockets();
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

  // Once per process, in the background: housekeeping must never slow a build.
  if (!porfforBuildsPruned) void prunePorfforBuilds().catch(() => {});

  const outDir = dirname(input.outPath);
  await mkdir(outDir, { recursive: true });
  // The artifact dir is content-addressed, so rebuilding unchanged source lands
  // on the previous binary — which `chmod 0555` left read-only, and which the
  // OS may still be executing. The linker cannot overwrite either, so clear it
  // first rather than failing with "can't write output file".
  await rm(input.outPath, { force: true });
  const generatedPath = await writeGenerated(input);

  // A musl build shells `zig` bare, so it needs its dir on PATH; a host build passes its compiler to the
  // build recipe below and has no zigBin to contribute here.
  const zigDir = input.zigBin ? `${dirname(input.zigBin)}:` : "";
  const hostCompiler = input.target === "host" ? await resolveHostCompiler() : undefined;
  const path = `${zigDir}${process.env.PATH ?? ""}`;
  await compileSproutA21(input, {
    generatedPath,
    launch: PACKAGED
      ? [process.execPath, "__porffor"]
      : [process.execPath, resolve(import.meta.dir, "main.ts"), "__porffor"],
    path,
    hostCompiler,
    uwsVariant,
  });
  await chmod(input.outPath, 0o555);
}

/**
 * The native compile (sproutd-alpha22-standalone-port.md): the generated module is compiled in sproutd's worker
 * shape (the toolchain composes `shared-prelude.js` from it: the helper names, the web classes, the dispatch
 * shim), the toolchain's patched compiler renders the split C units, and the toolchain's build recipe compiles
 * them with the native-fetch bridge and the vendored uWebSockets shim rewritten over flat data, then links with
 * this build's native objects (SQLite, BearSSL) and the uSockets this target already has.
 */
async function compileSproutA21(
  input: CompileInput,
  build: {
    generatedPath: string;
    launch: string[];
    path: string;
    hostCompiler?: { cc: string[]; cxx: string[]; usingZig: boolean };
    uwsVariant?: string;
  },
): Promise<void> {
  const a21Channel = standaloneA21Channel(porfforChannel());
  const a21 = await ensurePorfforA21(a21Channel);
  const dir = dirname(build.generatedPath);
  const composed = composeStandaloneA21(await readFile(build.generatedPath, "utf8"));
  // beside sprout.generated.js (which stays the wrapped module, for emit-only, dev and the cache key)
  await writeFile(resolve(dir, SHARED_PRELUDE_FILE), composed.sharedPrelude);
  const entry = resolve(dir, "sprout.a22.js");
  await writeFile(entry, composed.entry);
  const unitsDir = resolve(dir, "units-a22");
  await clearRenderedUnits(unitsDir);
  // the compiler's own build cache (keyed by entry path) is not used: `c` only renders
  const render = Bun.spawn(
    [
      ...build.launch,
      resolve(a21, "runtime/index.js"),
      "c",
      entry,
      "-o",
      `${unitsDir}/`,
      ...STANDALONE_A21_COMPILE_FLAGS,
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: build.path } },
  );
  const [code, stdout, stderr] = await Promise.all([
    render.exited,
    new Response(render.stdout).text(),
    new Response(render.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`Porffor (${a21Channel}) render failed: ${(stderr || stdout).trim() || `exit ${code}`}`);

  const host = input.target === "host";
  const triple = host ? undefined : linuxTriple(input.target);
  const cc = host ? build.hostCompiler!.cc : [input.zigBin!, "cc", "-target", triple!];
  const cxx = host ? build.hostCompiler!.cxx : [input.zigBin!, "c++", "-target", triple!];
  const uwsDir = resolve(
    homedir(),
    ".cache/porffor/deps",
    host ? `uWebSockets-${uwsCommitFull()}` : `uWebSockets-${uwsCommitFull()}-musl-${build.uwsVariant ?? "sa-x86_64"}`,
  );
  await buildStandaloneA21({
    unitsDir,
    outPath: input.outPath,
    cc,
    cxx,
    uwsDir,
    extraLink: input.extraLink,
    extraCflags: input.extraCflags,
    optimize: optimizeLevel(input.optimize, input.target),
    // LTO on for optimized builds, zig's musl cross builds included (romeo, M4: +11% req/s on hello,
    // +7% on stress, and 4% smaller), except a standalone build without --release (`lto: false`),
    // which skips it to link faster; SPROUTBOAT_FLTO=0 turns it off for measurements
    flto: ltoEnabled(input),
    musl: !host,
    strip: true,
  });
  if (!(await Bun.file(input.outPath).exists())) throw new Error("native build produced no binary");
}
