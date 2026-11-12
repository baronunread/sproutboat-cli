/**
 * The two backends a fixture is held to, as functions: the broker (a host sprout beside an in-process broker, the
 * shape the supervisor runs in production) and a standalone binary (one executable with the bindings inside it).
 *
 * `kitchen-sink/harness*.ts` and `conformance/harness*.ts` are a few lines each: they say which directory, which
 * secrets and which checks, and these functions do the rest, so the lifecycle code (deadlines, a step recorded
 * before each request, a failure report with the backend and versions, cleanup of this run's own children) exists
 * once. Both exit the process: 0 when every check passed, 1 with a report when one did not.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, type HarnessError } from "./harness";
import { loadPrelude, wrapNativeFetchHandler, type Bindings } from "../../src/compile";
import { parseConfig, resourceRefs, type SproutboatConfig } from "../../src/config";
import { createBroker, listen } from "../../src/broker";
import { walkAssets, type AssetManifest } from "../../src/assets";
import { buildStandalone } from "../../src/standalone-build";
import { bundleHandler } from "../../src/bundle";
import type { JsonValue } from "../../src/json";
import { ensurePorffor } from "../../src/porffor-toolchain";
import { ensureBearssl } from "../../src/bearssl";

const CLI = join(import.meta.dir, "../..");

export type CheckFn = (name: string, cond: boolean, detail?: JsonValue) => void;

export type Fixture = {
  /** The fixture's directory (`import.meta.dir` of the harness entry). */
  dir: string;
  /** Named in the output and the temp dir. */
  label: string;
  /** The value of the declared ADMIN_TOKEN secret. */
  adminToken: string;
  /** Runs before anything is built: the dashboard's UI, for kitchen-sink. */
  prepare?: () => void;
  /** The vars the checks need set on top of the config's, given the stub upstream's `host:port`. */
  vars?: (upstreamHost: string) => Record<string, string>;
  /** The checks. `check` reports, and aborts the run on a failure. */
  run: (context: RunContext) => Promise<void>;
};

export type RunContext = {
  base: string;
  /** SB_BROKER_TOKEN, for the internal trigger requests a broker sends (cron, queue). Unused by a standalone binary. */
  token: string;
  check: CheckFn;
  harness: Harness;
  /** `http://host:port` of the stub upstream; its /redirect answers 302 to a private address. */
  upstream: string;
  backend: "broker" | "standalone";
};

/** A port nothing is listening on: bind to 0, let the OS choose, and release it. */
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const chosen = probe.port;
  probe.stop(true);
  return chosen;
}

const QUOTES = [
  { content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { content: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { content: "Programs must be written for people to read.", author: "Harold Abelson" },
];

/** The stub upstream: a quote at any path, and /redirect, a 302 to a private address the suite checks is not followed (#174). */
function startUpstream() {
  return Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/redirect"
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.2/" } })
        : Response.json(QUOTES[Math.floor(Date.now() / 4000) % QUOTES.length]),
  });
}

function readConfig(dir: string): SproutboatConfig {
  const parsed = parseConfig(readFileSync(join(dir, "sproutboat.jsonc"), "utf8"));
  if (!parsed.ok) throw new Error("bad fixture config: " + parsed.errors.join("; "));
  return parsed.value;
}

function lifecycle(fixture: Fixture, backend: "broker" | "standalone", secrets: string[]) {
  const harness = new Harness({
    backend,
    prefix: `sb-${fixture.label}-${backend}-`,
    secrets,
  });
  const cleanup: Array<() => void> = [];
  let passed = 0;
  const die = (message: HarnessError): never => {
    console.error(harness.report(message));
    for (const stop of cleanup.reverse()) {
      try {
        stop();
      } catch {}
    }
    harness.cleanupSync();
    process.exit(1);
  };
  const check: CheckFn = (name, cond, detail) => {
    if (cond) {
      passed++;
      console.log("  ok  " + name);
    } else die(`${name}${detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  };
  const finish = async (message: string): Promise<never> => {
    console.log(`\n${passed} checks passed — ${message}`);
    for (const stop of cleanup.reverse()) {
      try {
        stop();
      } catch {}
    }
    await harness.cleanup();
    process.exit(0);
  };
  return { harness, cleanup, die, check, finish };
}

function bindingsOf(config: SproutboatConfig): Bindings {
  return {
    kv: resourceRefs(config.kv_namespaces).map((ref) => ref.binding),
    secrets: config.secrets ?? [],
    d1: resourceRefs(config.d1_databases).map((ref) => ref.binding),
    r2: resourceRefs(config.r2_buckets).map((ref) => ref.binding),
    queues: resourceRefs(config.queues).map((ref) => ref.binding),
    analytics: config.analytics_engine_datasets ?? [],
    do: Object.entries(config.durable_objects ?? {}).map(([binding, className]) => ({ binding, className })),
    services: config.services ?? [],
    crons: config.triggers?.crons ?? [],
    ratelimiters: config.ratelimiters ?? [],
    assets: config.assets?.binding ?? "",
  };
}

/** The broker backend: compiles the sprout for the host, stands up an in-process broker and a stub upstream, drives the fixture. */
export async function runBroker(fixture: Fixture): Promise<never> {
  const token = "harness-token";
  const { harness, cleanup, die, check, finish } = lifecycle(fixture, "broker", [fixture.adminToken, token]);
  const porf = join(await ensurePorffor(), "runtime/index.js");
  const config = readConfig(fixture.dir);

  const upstream = startUpstream();
  cleanup.push(() => upstream.stop(true));
  const upstreamHost = `127.0.0.1:${upstream.port}`;
  const vars = { ...config.vars, ...fixture.vars?.(upstreamHost) };

  // Publish the assets directory and its manifest exactly as `sproutboat build` would.
  fixture.prepare?.();
  const assetsDir = join(harness.workdir, "assets");
  if (config.assets) {
    const source = join(fixture.dir, config.assets.directory);
    if (!existsSync(source)) die(`assets dir not found: ${source}`);
    cpSync(source, assetsDir, { recursive: true });
    const manifest: AssetManifest = {
      notFound: config.assets.not_found_handling ?? "none",
      runSproutFirst: config.assets.run_sprout_first ?? false,
      files: walkAssets(assetsDir),
    };
    writeFileSync(join(harness.workdir, "assets.json"), JSON.stringify(manifest, null, 2));
  }

  // The prelude needs its transport spliced in; reading the file alone yields a module with no __sbCall (#15).
  const prelude = await loadPrelude("broker");
  const generated = join(harness.workdir, "sprout.generated.js");
  const binary = join(harness.workdir, "sprout.bin");
  // The config's compatibility date, as the standalone build has it: from it a response body can stream and a
  // Durable Object takes WebSockets.
  writeFileSync(
    generated,
    wrapNativeFetchHandler(
      readFileSync(join(fixture.dir, config.main), "utf8"),
      prelude,
      vars,
      bindingsOf(config),
      undefined,
      config.compatibility_date,
    ),
  );

  // The sprout uses crypto.subtle, so the compile needs BearSSL as a broker build gets it from the CLI.
  const tls = await harness.build("preparing BearSSL", () => ensureBearssl({ target: "host" })).catch(die);

  console.log("compiling sprout (host native)…");
  // Compilation has its own deadline (SB_HARNESS_BUILD_TIMEOUT_MS), so a slow build cannot look like a hung
  // handler. The compiler is killed on timeout.
  harness.step("compiling the sprout (host native)");
  const compile = Bun.spawn(["node", porf, "native", generated, "-o", binary], {
    env: {
      ...process.env,
      PATH: `${join(CLI, "node_modules/.bin")}:${process.env.PATH}`,
      SB_EXTRA_CFLAGS: `-I ${tls.includeDir}`,
      SB_EXTRA_LINK: tls.objects.slice(0, -1).join(" "),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: harness.buildTimeoutMs,
    killSignal: "SIGKILL",
  });
  const [compileOut, compileErr, compileCode] = await Promise.all([
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
    compile.exited,
  ]);
  if (compile.signalCode)
    die(`porffor compile did not finish within ${harness.buildTimeoutMs} ms (SB_HARNESS_BUILD_TIMEOUT_MS)`);
  if (compileCode !== 0) die("porffor compile failed:\n" + compileErr + compileOut);

  const sproutPort = freePort();
  const broker = createBroker({
    db: join(harness.workdir, "state.sqlite"),
    dataDir: join(harness.workdir, "d1"),
    token,
    bindings: bindingsOf(config),
    secrets: { ADMIN_TOKEN: fixture.adminToken },
    sproutUrl: `http://127.0.0.1:${sproutPort}/`,
    assetsDir,
    // #48: on a node the control plane resolves a service name to a hostname and the edge routes it. There is no
    // edge here, so the broker is pointed at the stub upstream, which stands in for the peer. A service binding must
    // reach a different deployment (one sprout serves one turn at a time, so a binding to this app would deadlock);
    // the path under test is shim -> broker -> Host header either way.
    services: { PEER: "quote-service.local" },
    edgeUrl: `http://${upstreamHost}/`,
    // The stub upstream is on loopback, which fetch() refuses (#174). Let exactly that address through, as an
    // operator would with SB_EGRESS_ALLOW.
    egressAllow: ["127.0.0.1"],
  });
  const brokerServer = listen(broker, "127.0.0.1", 0);
  cleanup.push(() => {
    brokerServer.stop();
    broker.close();
  });

  harness.spawn("sprout", [binary], {
    env: {
      ...process.env,
      PORT: String(sproutPort),
      SB_BROKER_PORT: String(brokerServer.port),
      SB_BROKER_TOKEN: token,
    },
    stdout: "inherit",
    tee: true,
  });
  const base = `http://127.0.0.1:${sproutPort}`;
  await harness.waitReady(base + "/").catch(die);

  await fixture.run({ base, token, check, harness, upstream: `http://${upstreamHost}`, backend: "broker" }).catch(die);
  return finish(`${fixture.label}: every check passed on the broker backend.`);
}

/** The standalone backend: one executable with the bindings compiled in, driven by the same checks. */
export async function runStandalone(fixture: Fixture): Promise<never> {
  const { harness, cleanup, die, check, finish } = lifecycle(fixture, "standalone", [fixture.adminToken]);
  const config = readConfig(fixture.dir);

  const upstream = startUpstream();
  cleanup.push(() => upstream.stop(true));
  const upstreamHost = `127.0.0.1:${upstream.port}`;
  // #48: service bindings need an edge, which a standalone binary has none of, and buildStandalone refuses them
  // outright. Drop them here rather than keep a second config; the deployed path is covered by the broker run.
  delete config.services;
  config.vars = { ...config.vars, ...fixture.vars?.(upstreamHost) };

  harness.step("preparing the fixture");
  fixture.prepare?.();
  const sourcePath = join(fixture.dir, config.main);
  const bundle = await bundleHandler(sourcePath, fixture.dir);

  console.log("building the standalone binary…");
  // Compilation has its own deadline (SB_HARNESS_BUILD_TIMEOUT_MS), so a slow build cannot look like a hung handler.
  const built = await harness
    .build("compiling the standalone binary", () =>
      buildStandalone({
        projectDir: fixture.dir,
        config,
        sourcePath,
        source: bundle.code,
        target: "host",
        outPath: join(harness.workdir, fixture.label),
      }),
    )
    .catch(die);
  console.log(`  ${(built.bytes / 1_000_000).toFixed(1)} MB\n`);

  const port = freePort();
  // Environment only: a native-fetch binary never sees argv (Porffor's runtime init calls porf_init(0, NULL)), so
  // PORT and SB_DATA_DIR are the whole surface. SB_EGRESS_ALLOW: the stub upstream is on loopback (#174).
  harness.spawn("standalone binary", [built.outPath], {
    env: {
      ...process.env,
      PORT: String(port),
      SB_DATA_DIR: join(harness.workdir, "data"),
      ADMIN_TOKEN: fixture.adminToken,
      SB_EGRESS_ALLOW: "127.0.0.1",
    },
  });
  const base = `http://127.0.0.1:${port}`;
  await harness.waitReady(base + "/").catch(die);

  console.log("bindings (standalone):");
  // The binary drives its own cron and queue timers and refuses external triggers, so the HTTP-delivered ones the
  // checks send to a broker do not apply here. The token is unused by it.
  await fixture
    .run({ base, token: "harness-token", check, harness, upstream: `http://${upstreamHost}`, backend: "standalone" })
    .catch(die);

  // baronunread/sproutboat#236: nginx proxies with HTTP/1.0 by default, which uWebSockets used to answer with 505.
  // Raw socket: fetch() always speaks 1.1.
  harness.step("HTTP/1.0 request over a raw socket");
  const http10 = await harness.rawExchange("127.0.0.1", port, "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").catch(die);
  check(
    "HTTP/1.0: answered with 200 and the connection closed",
    http10.reply.startsWith("HTTP/1.1 200") && http10.closed,
    {
      head: http10.reply.slice(0, 40),
      closed: http10.closed,
    },
  );
  return finish(`${fixture.label}: the same checks as the broker run, in one binary.`);
}
