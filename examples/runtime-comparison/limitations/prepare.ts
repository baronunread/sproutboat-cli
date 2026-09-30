import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { ensureZig, ensureUWebSockets } from "../../../src/toolchain";
import { cases } from "./cases";
const here = import.meta.dir;
const out = resolve(here, "../results/porffor-limitations-" + Date.now());
mkdirSync(out, { recursive: true });
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const zig = await ensureZig();
await ensureUWebSockets();
const versions = [
  {
    name: "pin",
    commit: "de4eb588264885b3a1596f75010e371a2052033f",
    root: "/private/tmp/sb-plain-porffor",
    archive: "1a62187a93356b36cb6ac703ce9770c8917e4fa65545fd7c33ee8a180ae5a4c9",
  },
  {
    name: "current",
    commit: "08ac7ee1077c05da2bec18dcca15197051e87b62",
    root: "/private/tmp/sb-porffor-current",
    archive: "d49ce6724efde555b4cdeea0d2610baddd4310153956c79b352d86ba9cf0f60f",
  },
];
const manifest: any = {
  purpose: "Independent native-fetch semantic probes; missing host APIs and reduced runtime failures",
  versions: [],
  transportChange: "loopback bind only",
  resourceLimits: { cpu: 1, memoryMiB: 512 },
  cases: cases.length,
};
for (const v of versions) {
  if (sha(join(v.root, "source.tgz")) !== v.archive) throw new Error("Archive mismatch");
  const compiler = join(out, v.name + "-source");
  cpSync(v.root, compiler, { recursive: true });
  const shim = join(compiler, "compiler/uwebsockets.js");
  const anchor = "  }).listen(port, [&listened, port](auto* token) {";
  const original = readFileSync(shim, "utf8");
  if (!original.includes(anchor)) throw new Error("Bind anchor missing");
  writeFileSync(shim, original.replace(anchor, '  }).listen("127.0.0.1", port, [&listened, port](auto* token) {'));
  const row: any = { ...v, root: undefined, attempts: [], compilerHashes: {} };
  manifest.versions.push(row);
  for (const async of [false, true]) {
    const name = v.name + (async ? "-async" : "-sync");
    const source = join(out, name + ".js");
    const binary = join(out, name);
    const body = cases
      .filter((c) => !!c.async === async)
      .map((c) => `if(path==='/${c.name}'){${c.code}}`)
      .join("\n");
    const helpers = `async function innerResponse(){return new Response('ok');}\nasync function innerThrow(){throw new Error('inner-rejection');}\n`;
    const routing = `const path=new URL(request.url).pathname;${body}return new Response('missing',{status:404});`;
    const server = async
      ? `export default {port:18082,async fetch(request){if(new URL(request.url).pathname==='/health')return new Response('ok');${routing}}};`
      : `function runCase(request){${routing}}\nexport default {port:18082,fetch(request){if(new URL(request.url).pathname==='/health')return new Response('ok');const result=runCase(request);if(result instanceof Response)return result;return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});}};`;
    writeFileSync(source, helpers + server);
    rmSync(binary, { force: true });
    const command = [
      process.execPath,
      join(compiler, "runtime/index.js"),
      "native",
      source,
      "-o",
      binary,
      "--musl",
      "-s",
    ];
    const child = Bun.spawn(command, {
      env: { ...process.env, PATH: dirname(zig) + ":" + process.env.PATH },
      stdout: Bun.file(join(out, name + ".compile.log")),
      stderr: Bun.file(join(out, name + ".compile.err")),
    });
    const code = await child.exited;
    const attempt: any = {
      name,
      code,
      sourceSha256: sha(source),
    };
    if (code === 0) {
      attempt.binarySha256 = sha(binary);
      attempt.binaryBytes = Bun.file(binary).size;
    }
    row.attempts.push(attempt);
    console.log(name, code);
  }
  for (const f of [
    "compiler/uwebsockets.js",
    "compiler/render.js",
    "compiler/builtins/json.ts",
    "compiler/builtins/promise.ts",
    "compiler/builtins_precompiled.js",
    "runtime/fetch-globals.js",
  ])
    row.compilerHashes[f] = sha(join(compiler, f));
}
cpSync(resolve(here, "../linux/measure.py"), join(out, "measure.py"));
cpSync(join(here, "run.py"), join(out, "run.py"));
cpSync(resolve(here, "../adapters/upstream.mjs"), join(out, "upstream.mjs"));
writeFileSync(join(out, "cases.json"), JSON.stringify(cases, null, 2));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(out);
