import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PORFFOR_ARCHIVE_SHA256, PORFFOR_COMMIT_FULL } from "../../../src/porffor-toolchain";
import { ensureZig, ensureUWebSockets } from "../../../src/toolchain";
import { corpus } from "../fixtures/corpus";
const here = resolve(import.meta.dir, "..");
const out = join(here, "results", "plain-porffor-" + Date.now());
mkdirSync(out, { recursive: true });
const pristine = process.env.PLAIN_PORFFOR_SOURCE || "/private/tmp/sb-plain-porffor";
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
if (sha(join(pristine, "source.tgz")) !== PORFFOR_ARCHIVE_SHA256) throw new Error("Pristine archive mismatch");
const compiler = join(out, "compiler-source");
cpSync(pristine, compiler, { recursive: true });
const shim = join(compiler, "compiler/uwebsockets.js");
const text = readFileSync(shim, "utf8");
const anchor = "  }).listen(port, [&listened, port](auto* token) {";
if (!text.includes(anchor)) throw new Error("Loopback anchor missing");
writeFileSync(shim, text.replace(anchor, '  }).listen("127.0.0.1", port, [&listened, port](auto* token) {'));
cpSync(join(here, "fixtures"), join(out, "fixtures"), { recursive: true });
cpSync(join(here, "adapters"), join(out, "adapters"), { recursive: true });
writeFileSync(join(out, "corpus.json"), JSON.stringify(corpus));
for (const file of ["measure.py", "measure-porffor.py"]) cpSync(join(import.meta.dir, file), join(out, file));
const zig = await ensureZig();
await ensureUWebSockets();
const manifest: any = {
  label: "Plain Porffor at identical Sproutboat compiler pin",
  pin: PORFFOR_COMMIT_FULL,
  archiveSha256: PORFFOR_ARCHIVE_SHA256,
  runtimePrelude: false,
  sproutboatCompilerPatches: false,
  transportOnlyChange: "bind loopback instead of all interfaces",
  attempts: [],
};
for (const variant of ["full", "subset"]) {
  const input = join(out, variant + ".js");
  if (variant === "full") cpSync(join(out, "adapters/porffor.js"), input);
  else {
    const app = readFileSync(join(here, "fixtures/app.js"), "utf8");
    const common = app.slice(app.indexOf("const buffers"), app.indexOf("async function signedOrder"));
    writeFileSync(
      input,
      common +
        `\nexport default { port: 18082, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/health') return reply('ok', 200, 'text/plain');
      if (path === '/order') {
        if (request.method !== 'POST') return reply('{"error":"method"}',405);
        return order(await request.text());
      }
      return reply('{"error":"unsupported-baseline"}',501);
    }};\n`,
    );
  }
  // Full adapter moved up one directory, so preserve its fixture import.
  if (variant === "full")
    writeFileSync(input, readFileSync(input, "utf8").replace("../fixtures/app.js", "./fixtures/app.js"));
  const binary = join(out, "porffor-" + variant);
  rmSync(binary, { force: true });
  const command = [process.execPath, join(compiler, "runtime/index.js"), "native", input, "-o", binary, "--musl", "-s"];
  const child = Bun.spawn(command, {
    env: { ...process.env, PATH: resolve(zig, "..") + ":" + process.env.PATH },
    stdout: Bun.file(join(out, variant + ".compile.log")),
    stderr: Bun.file(join(out, variant + ".compile.err")),
  });
  const code = await child.exited;
  const attempt: any = {
    variant,
    command,
    code,
    sourceSha256: sha(input),
  };
  if (code === 0) {
    attempt.binarySha256 = sha(binary);
    attempt.binaryBytes = Bun.file(binary).size;
  }
  manifest.attempts.push(attempt);
  console.log(variant, code);
}
manifest.fixtureHashes = Object.fromEntries(
  ["fixtures/app.js", "corpus.json", "measure.py", "measure-porffor.py"].map((f) => [f, sha(join(out, f))]),
);
manifest.compilerHashes = Object.fromEntries(
  ["compiler/uwebsockets.js", "compiler/render.js", "runtime/fetch-globals.js", "compiler/builtins_precompiled.js"].map(
    (f) => [f, sha(join(compiler, f))],
  ),
);
writeFileSync(join(out, "plain-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(out);
