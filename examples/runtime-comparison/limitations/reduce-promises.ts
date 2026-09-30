import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ensureZig } from "../../../src/toolchain";
import { cases } from "./cases";
const parent = resolve(process.argv[2]);
const previous = JSON.parse(readFileSync(join(parent, "manifest.json"), "utf8"));
const out = resolve(import.meta.dir, "../results/porffor-promises-minimal-" + Date.now());
mkdirSync(out, { recursive: true });
const zig = await ensureZig();
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const manifest: any = { purpose: "Minimal single-route return-vs-await reduction", versions: [] };
for (const v of previous.versions) {
  const compiler = join(parent, v.name + "-source");
  const row: any = { ...v, attempts: [] };
  manifest.versions.push(row);
  for (const mode of ["return", "await"]) {
    const name = v.name + "-" + mode + "-async";
    const source = join(out, name + ".js");
    const binary = join(out, name);
    writeFileSync(
      source,
      `async function inner(){return new Response('ok');}\nexport default {port:18082,async fetch(request){if(new URL(request.url).pathname==='/health')return new Response('ok');return ${mode === "await" ? "await " : ""}inner();}};`,
    );
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
    row.attempts.push({
      name,
      code,
      probe: "async-" + (mode === "await" ? "await" : "return") + "-inner",
      sourceSha256: sha(source),
      binarySha256: code === 0 ? sha(binary) : undefined,
    });
    console.log(name, code);
  }
}
for (const f of ["measure.py", "upstream.mjs"]) cpSync(join(parent, f), join(out, f));
cpSync(join(import.meta.dir, "run.py"), join(out, "run.py"));
writeFileSync(
  join(out, "cases.json"),
  JSON.stringify(cases.filter((c) => ["async-return-inner", "async-await-inner"].includes(c.name))),
);
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(out);
