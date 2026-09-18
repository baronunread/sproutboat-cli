/**
 * #89 — bundle the handler before Porffor sees it.
 *
 * Porffor compiles one self-contained module, so until now a project was one
 * file with no imports: no router, no validation library, no SDK, no splitting
 * a codebase in two. Bundling first lifts that without touching the compiler.
 *
 * Bun's bundler resolves relative imports across the project and bare
 * specifiers out of the project's own `node_modules`, then emits a single ESM
 * module. The capability bans (`process`, `Bun`, `node:`, WebSocket, …) are
 * checked against that output rather than the entry file, so a dependency
 * reaching for a Node API fails exactly as user code would.
 */
import { relative } from "node:path";
import { NODE_SHIMS } from "./node-shims";

export type BundleResult = {
  /** One self-contained ESM module: what gets validated, hashed, and compiled. */
  code: string;
};

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

const entryLabel = (entryPath: string, projectDir: string): string => relative(projectDir, entryPath) || entryPath;

const shimSpecifiers = new RegExp(
  `^(${Object.keys(NODE_SHIMS)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})$`,
);

/**
 * Bun already bundles working polyfills for most node:* built-ins under
 * `target: "browser"` (verified for node:url, node:querystring). This
 * plugin only overrides the ones in NODE_SHIMS — currently just node:path,
 * whose bundled resolve() otherwise falls back to `process.cwd()`.
 */
const nodeShimsPlugin: import("bun").BunPlugin = {
  name: "sproutboat-node-shims",
  setup(build) {
    build.onResolve({ filter: shimSpecifiers }, (args) => ({ path: args.path, namespace: "sb-node-shim" }));
    build.onLoad({ filter: /.*/, namespace: "sb-node-shim" }, (args) => ({
      // SAFETY: onResolve above only ever routes a specifier matched by
      // shimSpecifiers (built from NODE_SHIMS's own keys) into this
      // namespace, so args.path is always one of NODE_SHIMS's keys here.
      contents: (NODE_SHIMS as Record<string, string>)[args.path],
      loader: "js",
    }));
  },
};

/** Bun reports resolution failures on `AggregateError.errors`; its own message is just "Bundle failed". */
function bundleDetail(cause: unknown): string {
  const errors = cause instanceof AggregateError ? cause.errors : [];
  if (errors.length > 0)
    return errors.map((error) => `  ${error instanceof Error ? error.message : String(error)}`).join("\n");
  return `  ${cause instanceof Error ? cause.message : String(cause)}`;
}

/** Bundle `entryPath` into a single module, resolving imports from `projectDir`. */
export async function bundleHandler(entryPath: string, projectDir: string): Promise<BundleResult> {
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [entryPath],
      root: projectDir,
      // `browser` keeps the output free of Node shims — a dependency that wants
      // `process` must fail the capability check, not get a polyfill smuggled in.
      target: "browser",
      format: "esm",
      // Readability over size: a compile error from Porffor should point at
      // something a human can find, and Porffor strips the binary anyway.
      minify: false,
      splitting: false,
      sourcemap: "none",
      plugins: [nodeShimsPlugin],
    });
  } catch (cause) {
    // An unresolvable specifier arrives as an AggregateError whose `errors`
    // carry the useful part ("Could not resolve: ./missing.js"); the top-level
    // message is only "Bundle failed", which tells nobody which import broke.
    throw new BundleError(`could not bundle ${entryLabel(entryPath, projectDir)}:\n${bundleDetail(cause)}`);
  }

  if (!built.success) {
    const detail = built.logs.map((log) => `  ${log.message}`).join("\n");
    throw new BundleError(`could not bundle ${entryLabel(entryPath, projectDir)}:\n${detail}`);
  }
  const [output] = built.outputs;
  if (output === undefined) throw new BundleError("the bundler produced no output");

  return { code: await output.text() };
}
