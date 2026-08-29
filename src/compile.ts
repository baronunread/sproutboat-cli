/**
 * Compile `export default { fetch }` into a linux-x86_64 native-fetch server
 * binary. Porffor renders the handler to C; with `--musl` it cross-compiles via
 * `zig cc -target x86_64-linux-musl` and statically links, so the same command
 * works from macOS, Linux, or WSL with no Docker.
 *
 * One-time per machine: Porffor git-clones uWebSockets and builds `uSockets.a`
 * into ~/.cache/porffor/deps/ (needs `git` and `make` on PATH). Later builds
 * reuse it and take a few seconds.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensurePorfforPatched } from "./patch-porffor";
import { porfforRoot } from "./toolchain";

const preludePath = new URL("./native-fetch-prelude.js", import.meta.url);
// The server honours $PORT at runtime (patches/porffor-render.patch); this baked
// value is only a fallback for a directly-run binary.
const DEFAULT_PORT = 8080;
const COMPILE_TIMEOUT_MS = Number(process.env.SPROUTBOAT_COMPILE_TIMEOUT_MS || 600_000);

/**
 * Prepend the prelude (URLSearchParams / Response.json / crypto shims) and the
 * `env` binding (non-secret `vars` from sproutboat.jsonc, baked in), then the
 * handler body verbatim — no source rewriting. `env` is module-scoped, not a
 * `fetch` parameter: Porffor's native-fetch runtime calls `fetch(request)` with
 * one argument.
 */
export function wrapNativeFetchHandler(source: string, prelude: string, vars: Record<string, string> = {}): string {
  const match = /^\s*export\s+default\s*\{\s*(async\s+)?fetch\s*\(([^)]*)\)\s*\{([\s\S]*)\}\s*\}\s*;?\s*$/.exec(source);
  if (!match) throw new Error("handler must default-export an object with a fetch(request) method");
  const env = `const env = ${JSON.stringify(vars)};\n`;
  return `${prelude}\n${env}export default {\n  port: ${DEFAULT_PORT},\n  ${match[1] || ""}fetch(${match[2] || "request"}) {${match[3]}}\n};\n`;
}

export type CompileInput = {
  sourcePath: string;
  outPath: string;
  vars: Record<string, string>;
  zigBin: string;
};

/** Compile `sourcePath` to a native binary at `outPath` (mode 0555). */
export async function compileWorker(input: CompileInput): Promise<void> {
  await ensurePorfforPatched();
  const outDir = dirname(input.outPath);
  await mkdir(outDir, { recursive: true });
  const generatedPath = resolve(outDir, "worker.generated.js");
  const [source, prelude] = await Promise.all([readFile(input.sourcePath, "utf8"), readFile(preludePath, "utf8")]);
  await writeFile(generatedPath, wrapNativeFetchHandler(source, prelude, input.vars));

  const porffor = porfforRoot();
  const launcher = resolve(porffor, "runtime/index.js");
  // Porffor shells bare `zig` and `esbuild`; put both on PATH for the child.
  const binDir = resolve(porffor, "../.bin");
  const path = `${dirname(input.zigBin)}:${binDir}:${process.env.PATH ?? ""}`;

  const child = Bun.spawn(
    [process.execPath, launcher, "native", generatedPath, "-o", input.outPath, "--musl"],
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
