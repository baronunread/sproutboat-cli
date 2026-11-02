/**
 * #89 — bundle the handler before Porffor sees it.
 *
 * Porffor supports ESM imports. We still bundle first so capability
 * validation sees every dependency and the runtime wrapper receives one
 * controlled default export.
 *
 * Bun's bundler resolves relative imports across the project and bare
 * specifiers out of the project's own `node_modules`, then emits a single ESM
 * module. The capability bans (`process`, `Bun`, `node:`, WebSocket, …) are
 * checked against that output rather than the entry file, so a dependency
 * reaching for a Node API fails exactly as user code would.
 */
import { relative } from "node:path";
import { SOCKETS_DATE } from "@sproutboat/runtime";
import { NODE_SHIMS, SOCKET_NODE_SHIMS } from "./node-shims";

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

/** What a driver reads off `process`: an empty environment and a microtask for nextTick. */
const PROCESS_STUB = `
const env = {};
function nextTick(fn, ...args) { Promise.resolve().then(() => fn(...args)); }
const process = { env, platform: "linux", arch: "wasm32", version: "v20.0.0", versions: {}, argv: [], browser: true, nextTick, emitWarning() {}, cwd() { return "/"; }, stderr: { write() {} }, stdout: { write() {} }, on() {}, off() {}, once() {}, emit() {} };
export default process;
`;

/**
 * Node libraries use `Buffer` and `process` as free globals. Bun's browser target does not
 * inject them for a CommonJS file, so a dependency that never imports Buffer would throw a
 * ReferenceError at runtime. This gives every dependency file that uses one a local binding to the
 * bundled implementation (the `buffer` package, which Porffor compiles; see the toolchain notes on
 * typed array method dispatch). Applied only to node_modules, never to the handler's own code.
 */
const nodeGlobalsPlugin: import("bun").BunPlugin = {
  name: "sproutboat-node-globals",
  setup(build) {
    build.onResolve({ filter: /^sb-node-process$/ }, () => ({ path: "sb-node-process", namespace: "sb-node-global" }));
    build.onLoad({ filter: /.*/, namespace: "sb-node-global" }, () => ({ contents: PROCESS_STUB, loader: "js" }));
    build.onLoad({ filter: /node_modules\/.*\.(?:c?js|mjs)$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      const usesBuffer =
        /(?:^|[^.\w$])Buffer\s*[.(]/m.test(text) &&
        !/\b(?:import|require)\b[^;\n]*\bBuffer\b/.test(text) &&
        !/(?:const|let|var)\s+\{?\s*Buffer\b/.test(text);
      const usesProcess =
        /(?:^|[^.\w$])process\s*\./m.test(text) &&
        !/\b(?:import|require)\b[^;\n]*\bprocess\b/.test(text) &&
        !/(?:const|let|var|function)\s+\{?\s*process\b/.test(text);
      const usesGlobal =
        /(?:^|[^.\w$])global\s*\./m.test(text) && !/(?:const|let|var|function)\s+\{?\s*global\b/.test(text);
      if (!usesBuffer && !usesProcess && !usesGlobal) return undefined;
      const esm = /^\s*(?:import|export)\s/m.test(text);
      let prefix = "";
      if (usesBuffer) prefix += esm ? `import { Buffer } from "buffer";\n` : `var { Buffer } = require("buffer");\n`;
      if (usesProcess)
        prefix += esm
          ? `import process from "sb-node-process";\n`
          : `var process = require("sb-node-process").default;\n`;
      if (usesGlobal) prefix += "var global = globalThis;\n";
      return { contents: prefix + text, loader: "js" };
    });
  },
};

const socketShimSpecifiers = new RegExp(
  `^(${Object.keys(SOCKET_NODE_SHIMS)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})$`,
);

/** The Node built-ins a driver names, replaced from the sockets date: see SOCKET_NODE_SHIMS. */
const socketShimsPlugin: import("bun").BunPlugin = {
  name: "sproutboat-socket-shims",
  setup(build) {
    build.onResolve({ filter: socketShimSpecifiers }, (args) => ({ path: args.path, namespace: "sb-socket-shim" }));
    build.onLoad({ filter: /.*/, namespace: "sb-socket-shim" }, (args) => ({
      // SAFETY: onResolve above only routes specifiers built from SOCKET_NODE_SHIMS's own keys here.
      contents: (SOCKET_NODE_SHIMS as Record<string, string>)[args.path],
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
export async function bundleHandler(
  entryPath: string,
  projectDir: string,
  options: { compatibilityDate?: string } = {},
): Promise<BundleResult> {
  // From the sockets date a driver bundles as it does for workerd: its "workerd" export condition,
  // Node's free `Buffer`/`process`/`global` bound to bundled code, and net/tls/dns/fs/crypto shims
  // that name cloudflare:sockets when the driver takes its Node path.
  const sockets = options.compatibilityDate !== undefined && options.compatibilityDate >= SOCKETS_DATE;
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
      conditions: sockets ? ["workerd", "worker"] : undefined,
      plugins: sockets ? [nodeShimsPlugin, socketShimsPlugin, nodeGlobalsPlugin] : [nodeShimsPlugin],
      // WorkerEntrypoint, DurableObject, RpcTarget and env are runtime globals; the
      // compiler turns this import into them, so it stays in the bundle as written.
      external: ["cloudflare:workers", "cloudflare:sockets"],
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
