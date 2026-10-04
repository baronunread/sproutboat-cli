#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensurePorffor, PORFFOR_COMMIT_FULL } from "../../src/porffor-toolchain";
import { preludePath } from "../../src/wrap";
import { buildStandalone } from "../../src/standalone-build";
import { bundleHandler } from "../../src/bundle";
import { corpus } from "./fixtures/corpus";
import { pilot } from "./pilot";

const here = import.meta.dir;
const selected = (process.env.RUNTIMES || "node,workerd,sproutboat").split(",");
if (selected.some((name) => !["node", "workerd", "sproutboat"].includes(name))) throw new Error("Unknown runtime");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(here, "results", runId);
mkdirSync(out, { recursive: true });
const children: ReturnType<typeof Bun.spawn>[] = [];
const report: any = {
  schema: 1,
  runId,
  purpose: "development correctness check; not a capacity benchmark",
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  sourceHashes: {},
  runtimes: [],
};
for (const file of [
  "fixtures/app.js",
  "fixtures/corpus.ts",
  "adapters/node.mjs",
  "adapters/upstream.mjs",
  "adapters/workerd.js",
  "adapters/sproutboat.js",
  "run.ts",
  "pilot.ts",
]) {
  report.sourceHashes[file] = createHash("sha256")
    .update(readFileSync(join(here, file)))
    .digest("hex");
}
function freePort() {
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  return port;
}
function version(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Version command failed: ${command.join(" ")}`);
  return result.stdout.toString().trim();
}
type RuntimeEnvironment = NodeJS.ProcessEnv & { PORT: string; SB_DATA_DIR?: string };
async function request(base: string, probe: (typeof corpus)[number]) {
  const headers = new Headers({ "content-type": "application/json" });
  if (probe.signature) headers.set("x-signature", probe.signature);
  const response = await fetch(base + probe.path, {
    method: probe.method || "GET",
    body: probe.body,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  const actual = await response.text();
  return {
    name: probe.name,
    ok:
      response.status === probe.status &&
      actual === probe.expected &&
      response.headers.get("content-type") === probe.type,
    status: response.status,
    expectedStatus: probe.status,
    bodyMatch: actual === probe.expected,
    actualPreview: actual !== probe.expected ? actual.slice(0, 256) : null,
    expectedPreview: actual !== probe.expected ? probe.expected.slice(0, 256) : null,
    type: response.headers.get("content-type"),
    expectedType: probe.type,
    bodyHash: createHash("sha256").update(actual).digest("hex"),
  };
}
try {
  const upstreamPort = freePort();
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
  const upstream = Bun.spawn([process.env.NODE_BIN || "node", join(here, "adapters/upstream.mjs")], {
    env: { ...process.env, PORT: String(upstreamPort) },
    stdout: Bun.file(join(out, "upstream.stdout.log")),
    stderr: Bun.file(join(out, "upstream.stderr.log")),
  });
  children.push(upstream);
  let upstreamReady = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(upstreamBase + "/health", { signal: AbortSignal.timeout(500) });
      if ((await response.text()) === "ok") {
        upstreamReady = true;
        break;
      }
    } catch {}
    if (upstream.exitCode !== null) break;
    await Bun.sleep(20);
  }
  if (!upstreamReady) throw new Error("Controlled upstream failed to start");
  report.upstream = {
    url: upstreamBase,
    process: "separate Node process on the same development host",
    delaysMs: [0, 10, 50, 200],
    bodyBytes: 4096,
  };
  for (const runtime of selected) {
    const row: any = { runtime, status: "failed", probes: [] };
    report.runtimes.push(row);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const port = freePort();
      const base = `http://127.0.0.1:${port}`;
      let command: string[];
      // SB_EGRESS_ALLOW: the upstream is on loopback, which a sprout's fetch() refuses (#174).
      let env: RuntimeEnvironment = {
        ...process.env,
        PORT: String(port),
        BENCH_UPSTREAM: upstreamBase,
        SB_EGRESS_ALLOW: "127.0.0.1",
      };
      if (runtime === "node") {
        const node = process.env.NODE_BIN || "node";
        row.version = version([node, "--version"]);
        command = [node, join(here, "adapters/node.mjs")];
      } else if (runtime === "workerd") {
        const workerd = process.env.WORKERD_BIN || "workerd";
        row.version = version([workerd, "--version"]);
        const bundle = await bundleHandler(join(here, "adapters/workerd.js"), here);
        writeFileSync(join(out, "worker.js"), bundle.code);
        writeFileSync(
          join(out, "config.capnp"),
          `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    modules = [(name = "worker.js", esModule = embed "worker.js")],
    compatibilityDate = "2026-09-01",
    bindings = [(name = "BENCH_UPSTREAM", text = "${upstreamBase}")]
  )), (name = "internet", network = (allow = ["127.0.0.1/32"]))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);
`,
        );
        row.compatibilityDate = "2026-09-01";
        command = [workerd, "serve", join(out, "config.capnp")];
      } else {
        row.version = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")).version;
        row.packages = {};
        if (process.env.COMPARISON_LOCAL_TOOLCHAIN) {
          const local = process.env.COMPARISON_LOCAL_TOOLCHAIN;
          row.toolchainOverride = { path: local, released: false, sourceHashes: {} };
          for (const file of ["src/patch.ts", "src/unicode.ts", "src/pin.ts"]) {
            row.toolchainOverride.sourceHashes[file] = createHash("sha256")
              .update(readFileSync(join(local, file)))
              .digest("hex");
          }
        }
        row.loadedPrelude = {
          path: preludePath.href,
          sha256: createHash("sha256").update(readFileSync(preludePath)).digest("hex"),
        };
        if (process.env.COMPARISON_LOCAL_RUNTIME) {
          const local = process.env.COMPARISON_LOCAL_RUNTIME;
          row.runtimeOverride = { path: local, released: false, sourceHashes: {} };
          for (const file of [
            "src/native-fetch-prelude.js",
            "src/wrap.ts",
            "src/transport-embedded.js",
            "src/transport-broker.js",
          ]) {
            row.runtimeOverride.sourceHashes[file] = createHash("sha256")
              .update(readFileSync(join(local, file)))
              .digest("hex");
          }
        }
        for (const name of ["runtime", "toolchain", "wire"]) {
          row.packages[name] = JSON.parse(
            readFileSync(Bun.resolveSync(`@sproutboat/${name}/package.json`, here), "utf8"),
          ).version;
        }
        const binary = join(out, "sprout");
        rmSync(binary, { force: true });
        const sourcePath = join(here, "adapters/sproutboat.js");
        const bundle = await bundleHandler(sourcePath, here);
        const started = performance.now();
        await buildStandalone({
          projectDir: here,
          config: {
            name: "runtime-comparison",
            main: "adapters/sproutboat.js",
            compatibility_date: "2026-09-01",
            vars: { BENCH_UPSTREAM: upstreamBase },
          },
          sourcePath,
          source: bundle.code,
          target: "host",
          outPath: binary,
          outputDirectory: join(out, "artifact"),
          optimize: "release",
        });
        row.buildMs = performance.now() - started;
        const compilerRoot = await ensurePorffor();
        row.compiler = { expectedPin: PORFFOR_COMMIT_FULL, sourceHashes: {} };
        for (const file of [
          "compiler/render.js",
          "compiler/builtins/json.ts",
          "compiler/builtins_precompiled.js",
          "runtime/fetch-globals.js",
        ]) {
          row.compiler.sourceHashes[file] = createHash("sha256")
            .update(readFileSync(join(compilerRoot, file)))
            .digest("hex");
        }
        row.binaryBytes = statSync(binary).size;
        row.binaryHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
        env = { ...env, SB_DATA_DIR: join(out, "data") };
        command = [binary];
      }
      row.command = command;
      const stdout = Bun.file(join(out, `${runtime}.stdout.log`));
      const stderr = Bun.file(join(out, `${runtime}.stderr.log`));
      child = Bun.spawn(command, { env, stdout, stderr });
      children.push(child);
      const deadline = performance.now() + 15000;
      let ready = false;
      while (performance.now() < deadline && child.exitCode === null) {
        try {
          if ((await request(base, corpus[0])).ok) {
            ready = true;
            break;
          }
        } catch {}
        await Bun.sleep(20);
      }
      if (!ready) throw new Error("Startup failed or timed out; see runtime logs");
      for (const probe of corpus) {
        try {
          row.probes.push(await request(base, probe));
        } catch (error) {
          row.probes.push({ name: probe.name, ok: false, error: String(error) });
        }
      }
      row.correctnessStatus = row.probes.every((probe: any) => probe.ok) ? "passed" : "failed";
      if (process.env.PILOT_RPS && row.probes.every((probe: any) => probe.ok)) {
        row.pilot = await pilot(
          base,
          Number(process.env.PILOT_RPS),
          Number(process.env.PILOT_SECONDS || 5),
          process.env.PILOT_WORKLOAD || "order",
        );
        if (row.pilot.generatorDropped || row.pilot.incorrectOrFailed)
          throw new Error("Pilot failed; inspect request accounting");
      }
      row.status = row.probes.every((probe: any) => probe.ok) ? "passed" : "failed";
      console.log(`${runtime}: ${row.probes.filter((probe: any) => probe.ok).length}/${corpus.length} correct`);
    } catch (error) {
      row.error = String(error);
      console.error(`${runtime}: ${row.error}`);
    } finally {
      if (child) {
        child.kill();
        await child.exited;
      }
      writeFileSync(join(out, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
    }
  }
} finally {
  for (const child of children) if (child.exitCode === null) child.kill(9);
  await Promise.all(children.map((child) => child.exited));
  writeFileSync(join(out, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`Results: ${out}`);
if (report.runtimes.some((row: any) => row.status !== "passed")) process.exitCode = 1;
