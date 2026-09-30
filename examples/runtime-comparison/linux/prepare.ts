import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { buildStandalone } from "../../../src/standalone-build";
import { bundleHandler } from "../../../src/bundle";
import { ensurePorffor, PORFFOR_COMMIT_FULL } from "../../../src/porffor-toolchain";
import { corpus } from "../fixtures/corpus";
import { preludePath } from "../../../src/wrap";
const here = resolve(import.meta.dir, "..");
const repo = resolve(here, "../..");
const tag = execFileSync("git", ["describe", "--exact-match", "--tags", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
if (trackedChanges) throw new Error("Tagged comparison requires a clean tracked CLI checkout");
const cliVersion = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
if (tag !== `v${cliVersion}`) throw new Error(`Tag ${tag} does not match CLI package version ${cliVersion}`);
const out = join(here, "results", "linux-payload-" + Date.now());
mkdirSync(out, { recursive: true });
const compiler = await ensurePorffor();
// Patch an isolated compiler copy for loopback ingress. Never modify the
// installed compiler cache: subsequent tagged runs must start from the same pin.
const isolated = join(out, "compiler");
cpSync(compiler, isolated, { recursive: true });
const shim = join(isolated, "compiler/uwebsockets.js");
const source = readFileSync(shim, "utf8");
const anchor = "  }).listen(port, [&listened, port](auto* token) {";
const loopback = '  }).listen("127.0.0.1", port, [&listened, port](auto* token) {';
if (!source.includes(anchor) && !source.includes(loopback)) throw new Error("Native loopback bind anchor missing");
if (source.includes(anchor)) writeFileSync(shim, source.replace(anchor, loopback));
process.env.SPROUTBOAT_PORFFOR_DIR = isolated;
const entry = join(here, "adapters/sproutboat.js");
const bundle = await bundleHandler(entry, here);
const upstreamPort = 18081;
const started = performance.now();
const built = await buildStandalone({
  projectDir: here,
  config: {
    name: "runtime-comparison",
    main: "adapters/sproutboat.js",
    compatibility_date: "2026-09-01",
    vars: { BENCH_UPSTREAM: `http://127.0.0.1:${upstreamPort}` },
    outbound: [`127.0.0.1:${upstreamPort}`],
  },
  sourcePath: entry,
  source: bundle.code,
  target: "linux-x86_64",
  optimize: "release",
  outPath: join(out, "sprout"),
  outputDirectory: join(out, "artifact"),
});
const buildMs = performance.now() - started;
delete process.env.SPROUTBOAT_PORFFOR_DIR;
cpSync(join(here, "fixtures"), join(out, "fixtures"), { recursive: true });
cpSync(join(here, "adapters"), join(out, "adapters"), { recursive: true });
cpSync(join(import.meta.dir, "measure.py"), join(out, "measure.py"));
cpSync(join(import.meta.dir, "report.py"), join(out, "report.py"));
writeFileSync(join(out, "corpus.json"), JSON.stringify(corpus));
const worker = await bundleHandler(join(here, "adapters/workerd.js"), here);
writeFileSync(join(out, "worker.js"), worker.code);
const hashes: Record<string, string> = {};
for (const file of [
  "compiler/uwebsockets.js",
  "compiler/render.js",
  "compiler/builtins/json.ts",
  "compiler/builtins_precompiled.js",
  "runtime/fetch-globals.js",
])
  hashes[file] = createHash("sha256")
    .update(readFileSync(join(isolated, file)))
    .digest("hex");
const packages: Record<string, string> = {};
for (const name of ["runtime", "toolchain", "wire"])
  packages[name] = JSON.parse(readFileSync(Bun.resolveSync(`@sproutboat/${name}/package.json`, here), "utf8")).version;
const sourceHashes: Record<string, string> = {};
for (const file of [
  "fixtures/app.js",
  "fixtures/corpus.ts",
  "adapters/node.mjs",
  "adapters/workerd.js",
  "adapters/sproutboat.js",
  "linux/measure.py",
  "linux/report.py",
])
  sourceHashes[file] = createHash("sha256")
    .update(readFileSync(join(here, file)))
    .digest("hex");
writeFileSync(
  join(out, "payload.json"),
  JSON.stringify(
    {
      purpose: "Tagged CLI direct-app comparison",
      cliTag: tag,
      cliCommit: commit,
      cliVersion,
      packages,
      sourceHashes,
      expectedPin: PORFFOR_COMMIT_FULL,
      compilerHashes: hashes,
      preludeHash: createHash("sha256").update(readFileSync(preludePath)).digest("hex"),
      binaryBytes: built.bytes,
      binaryHash: createHash("sha256").update(readFileSync(built.outPath)).digest("hex"),
      buildMs,
      upstreamPort,
      loopbackBind: true,
      target: "linux-x86_64",
    },
    null,
    2,
  ),
);
rmSync(isolated, { recursive: true, force: true });
console.log(`Prepared Linux payload: ${out}`);
