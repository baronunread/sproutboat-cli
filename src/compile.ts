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
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensurePorfforPatched } from "./patch-porffor";
import { ensureUWebSockets, porfforRoot, UwsUnavailableError } from "./toolchain";

const preludePath = new URL("./native-fetch-prelude.js", import.meta.url);
// The server honours $PORT at runtime (patches/porffor-render.patch); this baked
// value is only a fallback for a directly-run binary.
const DEFAULT_PORT = 8080;
const COMPILE_TIMEOUT_MS = Number(process.env.SPROUTBOAT_COMPILE_TIMEOUT_MS || 600_000);

/**
 * Binding names a project declares. `do` maps a binding name to a Durable Object
 * class name; `crons` are schedule expressions with no name.
 */
export type Bindings = {
  kv: string[];
  secrets: string[];
  outbound: string[];
  d1: string[];
  r2: string[];
  queues: string[];
  analytics: string[];
  do: Array<{ binding: string; className: string }>;
  crons: string[];
  /** Static-asset binding name for `env.<NAME>.fetch(request)`; `""` when assets are edge-only. */
  assets: string;
};

const EMPTY_BINDINGS: Bindings = { kv: [], secrets: [], outbound: [], d1: [], r2: [], queues: [], analytics: [], do: [], crons: [], assets: "" };

function hasBindings(b: Bindings): boolean {
  return (
    b.kv.length > 0 || b.secrets.length > 0 || b.outbound.length > 0 || b.d1.length > 0 || b.r2.length > 0 ||
    b.queues.length > 0 || b.analytics.length > 0 || b.do.length > 0 || b.assets !== ""
  );
}

/**
 * Build the final native-fetch module: the prelude (Web API shims + the broker
 * binding shim + the trigger dispatcher), then `const env = {…}` with the baked
 * `vars`, then — if any binding is declared — one `__sbInstallBindings(env, …)`
 * line, then the user's source with its `export` keywords neutralised (so its
 * `export default {…}` becomes a plain object we can hand to the dispatcher),
 * then our single `export default { fetch }` that routes every request through
 * `__sbEntry` (HTTP → `handlers.fetch`; `x-sb-trigger` → scheduled / queue / DO).
 *
 * With no bindings and no `scheduled`/`queue`/DO the output behaves exactly like
 * a plain `export default { fetch }` worker.
 */
export function wrapNativeFetchHandler(
  source: string,
  prelude: string,
  vars: Record<string, string> = {},
  bindings: Bindings = EMPTY_BINDINGS,
): string {
  if (!/\bexport\s+default\s*\{/.test(source) || !/\bfetch\s*\(/.test(source)) {
    throw new Error("handler must default-export an object with a fetch(request) method");
  }
  // Neutralise the module's exports: its default object becomes `__sbHandlers`,
  // and any `export class`/`function`/`const` (Durable Object classes, helpers)
  // becomes a plain top-level declaration. Imports are already rejected upstream.
  const neutralised = source
    .replace(/^(\s*)export\s+default\s*/m, "$1const __sbHandlers = ")
    .replace(/^export\s+(async\s+function|function|class|const|let|var)\b/gm, "$1");

  const env = `const env = ${JSON.stringify(vars)};\nglobalThis.env = env;\n`;
  const wire = hasBindings(bindings) ? `__sbInstallBindings(env, ${JSON.stringify(bindings)});\n` : "";
  const registerDO = bindings.do.length
    ? `__sbRegisterDO({ ${bindings.do.map((d) => `${d.className}: ${d.className}`).join(", ")} });\n`
    : "";

  return (
    `${prelude}\n${env}${wire}` +
    `${neutralised}\n` +
    `${registerDO}` +
    `export default {\n  port: ${DEFAULT_PORT},\n  fetch(request) { return __sbEntry(__sbHandlers, request); }\n};\n`
  );
}

export type CompileInput = {
  sourcePath: string;
  outPath: string;
  vars: Record<string, string>;
  bindings?: Bindings;
  zigBin: string;
};

/** Compile `sourcePath` to a native binary at `outPath` (mode 0555). */
export async function compileWorker(input: CompileInput): Promise<void> {
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
  const generatedPath = resolve(outDir, "worker.generated.js");
  const [source, prelude] = await Promise.all([readFile(input.sourcePath, "utf8"), readFile(preludePath, "utf8")]);
  await writeFile(generatedPath, wrapNativeFetchHandler(source, prelude, input.vars, input.bindings ?? EMPTY_BINDINGS));

  const porffor = porfforRoot();
  const launcher = resolve(porffor, "runtime/index.js");
  // Porffor shells bare `zig` and `esbuild`; put both on PATH for the child.
  const binDir = resolve(porffor, "../.bin");
  const path = `${dirname(input.zigBin)}:${binDir}:${process.env.PATH ?? ""}`;

  // `-s`: strip at link. The unstripped static-musl binary is ~90% DWARF that
  // nothing needs at runtime (12 MB -> ~1.3 MB for the kitchen-sink). Porffor
  // forwards `-s` straight to the `zig cc` link step.
  const child = Bun.spawn(
    [process.execPath, launcher, "native", generatedPath, "-o", input.outPath, "--musl", "-s"],
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
