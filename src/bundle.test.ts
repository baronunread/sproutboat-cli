import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleHandler, BundleError } from "./bundle";
import { validateHttpSyncSource } from "./source";
import { neutraliseExports } from "./wrap";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-bundle-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

test("#89: relative imports are resolved into one module", async () => {
  const dir = project({
    "src/lib/greet.js": `export const greet = () => "hi";`,
    "src/index.js": `import { greet } from "./lib/greet.js";\nexport default { fetch() { return new Response(greet()); } };`,
  });
  try {
    const { code } = await bundleHandler(join(dir, "src/index.js"), dir);
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).toContain(`"hi"`);
    // The bundled shape must still read as a handler to both the validator and
    // the compiler, or `check` and `build` disagree about the same file.
    expect(validateHttpSyncSource(code).ok).toBe(true);
    expect(neutraliseExports(code)).toContain("const __sbHandlers =");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#89: a Node API reached through a dependency is still rejected", async () => {
  const dir = project({
    "src/sneaky.js": `export const cwd = () => process.cwd();`,
    "src/index.js": `import { cwd } from "./sneaky.js";\nexport default { fetch() { return new Response(cwd()); } };`,
  });
  try {
    const { code } = await bundleHandler(join(dir, "src/index.js"), dir);
    const result = validateHttpSyncSource(code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join(" ")).toContain("Node, Bun, and Deno APIs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * #132 — zod v4 declares its own `process(schema, ctx)`. A bare `\bprocess\b`
 * match flagged that local binding as readily as the Node global, refusing
 * any handler that merely imports zod. A platform API is always reached
 * through a member access or `new`; a local function call is neither.
 */
test("#132: a locally-declared process() is not the Node global", () => {
  const result = validateHttpSyncSource(
    `function process(x) { return x; }\nvar d={fetch(){return new Response(String(process({})));}};export{d as default};`,
  );
  expect(result.ok).toBe(true);
});

test("#132: process.env, Bun/Deno globals, and new Buffer are still rejected", () => {
  for (const snippet of [
    `var d={fetch(){return new Response(process.env.HOME);}};export{d as default};`,
    `var d={fetch(){return new Response(Bun.file('x').size);}};export{d as default};`,
    `var d={fetch(){return new Response(Deno.env.get('x'));}};export{d as default};`,
    `var d={fetch(){return new Response(Buffer.from('x'));}};export{d as default};`,
    `var d={fetch(){return new Response(new Buffer('x'));}};export{d as default};`,
  ]) {
    const result = validateHttpSyncSource(snippet);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join(" ")).toContain("Node, Bun, and Deno APIs");
  }
});

// A real bundle comment ended "...unique to this process. The id is..." —
// the sentence-ending period after the word, not member access, still
// matched an earlier version of this fix's own regex.
test("#132: 'process.' at the end of a sentence is not member access", () => {
  const result = validateHttpSyncSource(
    `// a comment unique to this process. The rest follows.\nvar d={fetch(){return new Response("ok");}};export{d as default};`,
  );
  expect(result.ok).toBe(true);
});

test("#132: node: only means something as a specifier-shaped string, not any substring", () => {
  // Shaped like an import specifier -- still rejected.
  expect(
    validateHttpSyncSource(`var d={fetch(){return new Response(require("node:fs"));}};export{d as default};`).ok,
  ).toBe(false);
  // Mid-sentence mention in an ordinary string a dependency happens to build -- not a specifier, must pass.
  expect(
    validateHttpSyncSource(
      `var msg="see node:fs docs";var d={fetch(){return new Response(msg);}};export{d as default};`,
    ).ok,
  ).toBe(true);
});

test("#89: an unresolvable import names the specifier that failed", async () => {
  const dir = project({
    "src/index.js": `import { x } from "./missing.js";\nexport default { fetch() { return new Response(x); } };`,
  });
  try {
    let thrown: Error | null = null;
    try {
      await bundleHandler(join(dir, "src/index.js"), dir);
    } catch (cause) {
      thrown = cause instanceof Error ? cause : new Error(String(cause));
    }
    expect(thrown).toBeInstanceOf(BundleError);
    expect(thrown?.message).toContain("./missing.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neutraliseExports handles the bundled re-export shape, aliases included", () => {
  const bundled = `var src_default = { fetch() {} };\nclass Counter {}\nexport { src_default as default, Counter, Counter as Renamed };`;
  const out = neutraliseExports(bundled);
  expect(out).toContain("const __sbHandlers = src_default;");
  expect(out).toContain("const Renamed = Counter;");
  expect(out).not.toMatch(/^export\s*\{/m);
});

test("neutraliseExports still handles a hand-written inline default export", () => {
  const out = neutraliseExports(`export default { fetch() {} };\nexport class Counter {}`);
  expect(out).toContain("const __sbHandlers = { fetch() {} };");
  expect(out).toContain("class Counter {}");
  expect(out).not.toMatch(/\bexport\s/);
});

test("neutraliseExports handles a minified one-line bundle", () => {
  const out = neutraliseExports(`var d={fetch(){}};export{d as default};`);
  expect(out).toBe(`var d={fetch(){}};const __sbHandlers = d;`);
});

test("dynamic import() is rejected: nothing can resolve it at build time", () => {
  const result = validateHttpSyncSource(
    `var d={async fetch(){const m=await import("./x.js");return new Response(m.v);}};export{d as default};`,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.errors.join(" ")).toContain("dynamic import()");
});

test("neutraliseExports rejects a module with no default export", () => {
  expect(neutraliseExports(`export { a };`)).toBeNull();
  expect(neutraliseExports(`const x = 1;`)).toBeNull();
});

/**
 * Porffor alpha-4 compiles `new Proxy` and then ignores the handler — the
 * trapped property is `undefined`, with no throw. `check` has to reject it, or
 * the first sign of trouble is a 502 from a handler that built cleanly.
 */
test("Proxy is rejected: the compiler ignores its traps", () => {
  const viaSource = validateHttpSyncSource(
    `var d={fetch(){const p=new Proxy({},{get:()=>1});return new Response(p.x);}};export{d as default};`,
  );
  expect(viaSource.ok).toBe(false);
  if (viaSource.ok) throw new Error("unreachable");
  expect(viaSource.errors.join(" ")).toContain("Proxy is not supported");

  expect(
    validateHttpSyncSource(`var d={fetch(){return new Response(Proxy.revocable({},{}).proxy);}};export{d as default};`)
      .ok,
  ).toBe(false);
  // A variable that merely mentions the word is not a Proxy construction.
  expect(
    validateHttpSyncSource(
      `var proxyUrl="http://x";var d={fetch(){return new Response(proxyUrl);}};export{d as default};`,
    ).ok,
  ).toBe(true);
});
