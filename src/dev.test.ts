import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAssetOnlyRefresh, runDev, tcpReady, type DevInput, type Running } from "./dev";

// SAFETY: this fixture supplies every required parsed configuration field.
const config = {
  name: "hello",
  main: "src/index.js",
  compatibility_date: "2026-08-26",
} as DevInput["config"];

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop();
  return port;
}

async function eventually(assertion: () => Promise<void> | void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await Bun.sleep(25);
    }
  }
  throw last;
}

test("dev: asset-only refresh reuses the native sprout, source/config changes do not", () => {
  const current = { config, source: "export default { fetch() {} }" };
  expect(isAssetOnlyRefresh(current, { ...current })).toBe(true);
  expect(
    isAssetOnlyRefresh(current, { ...current, source: "export default { fetch() { return new Response() } }" }),
  ).toBe(false);
  expect(isAssetOnlyRefresh(current, { ...current, config: { ...config, vars: { VERSION: "2" } } })).toBe(false);
});

test("dev: TCP readiness probes a socket without invoking an application route", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response("unexpected");
    },
  });
  try {
    expect(await tcpReady(server.port!, 100)).toBe(true);
    expect(requests).toBe(0);
  } finally {
    server.stop();
  }
});

test("dev: a failed replacement leaves the last good response on the stable port", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sproutboat-dev-"));
  const publicPort = freePort();
  await mkdir(join(projectDir, "src"));
  await writeFile(join(projectDir, "src/index.js"), "good");
  let builds = 0;
  const factory: NonNullable<DevInput["candidateFactory"]> = async (input, port) => {
    builds += 1;
    if (input.source === "bad") throw new Error("compile failed");
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(input.source) });
    const never = new Promise<number>(() => undefined);
    // SAFETY: this test factory only exercises coordinator ownership fields;
    // the broker and subprocess are never otherwise observed.
    return {
      sprout: { kill() {}, exited: never } as Bun.Subprocess,
      sproutPath: join(projectDir, "fake"),
      artifactDir: join(projectDir, `candidate-${builds}`),
      broker: {} as Running["broker"],
      stopBroker: () => server.stop(),
      expected: false,
      port,
      enableDispatch() {},
      disableDispatch() {},
    };
  };
  const task = runDev({
    projectDir,
    config,
    sourcePath: join(projectDir, "src/index.js"),
    source: "good",
    port: publicPort,
    watch: true,
    candidateFactory: factory,
    exitOnShutdown: false,
    rebuild: async () => ({
      config,
      sourcePath: join(projectDir, "src/index.js"),
      source: await Bun.file(join(projectDir, "src/index.js")).text(),
    }),
  });
  try {
    await Bun.sleep(80);
    expect(await (await fetch("http://127.0.0.1:" + publicPort + "/")).text()).toBe("good");
    await writeFile(join(projectDir, "src/index.js"), "bad");
    await Bun.sleep(300);
    expect(await (await fetch("http://127.0.0.1:" + publicPort + "/")).text()).toBe("good");
    expect(builds).toBe(2);
  } finally {
    process.emit("SIGTERM");
    await task;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("dev: saves during a slow rebuild coalesce and eventually serve the latest input", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sproutboat-dev-"));
  const publicPort = freePort();
  await mkdir(join(projectDir, "src"));
  const path = join(projectDir, "src/index.js");
  await writeFile(path, "one");
  const factory: NonNullable<DevInput["candidateFactory"]> = async (input, port) => {
    if (input.source === "two") await Bun.sleep(250);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(input.source) });
    const never = new Promise<number>(() => undefined);
    // SAFETY: only the coordinator's stop/exit fields are used by this fake.
    return {
      sprout: { kill() {}, exited: never } as Bun.Subprocess,
      sproutPath: path,
      artifactDir: `${path}-${port}`,
      broker: {} as Running["broker"],
      stopBroker: () => server.stop(),
      expected: false,
      port,
      enableDispatch() {},
      disableDispatch() {},
    };
  };
  const task = runDev({
    projectDir,
    config,
    sourcePath: path,
    source: "one",
    port: publicPort,
    watch: true,
    candidateFactory: factory,
    exitOnShutdown: false,
    rebuild: async () => ({ config, sourcePath: path, source: await Bun.file(path).text() }),
  });
  try {
    await Bun.sleep(80);
    await writeFile(path, "two");
    await Bun.sleep(150);
    await writeFile(path, "three");
    await Bun.sleep(600);
    expect(await (await fetch("http://127.0.0.1:" + publicPort + "/")).text()).toBe("three");
  } finally {
    process.emit("SIGTERM");
    await task;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("dev: config, entry, bindings and source changes rebuild the current project", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sproutboat-dev-"));
  const publicPort = freePort();
  const sourceDir = join(projectDir, "src");
  const configPath = join(projectDir, "sproutboat.jsonc");
  const one = join(sourceDir, "one.js");
  const two = join(sourceDir, "two.js");
  await mkdir(sourceDir);
  await writeFile(one, "one");
  await writeFile(two, "two");
  await writeFile(configPath, JSON.stringify({ main: "src/one.js", version: "v1" }));
  const seen: string[] = [];
  const factory: NonNullable<DevInput["candidateFactory"]> = async (input, port) => {
    const body = `${input.sourcePath}:${input.source}:${input.config.vars?.VERSION ?? ""}`;
    seen.push(body);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(body) });
    const never = new Promise<number>(() => undefined);
    return {
      // SAFETY: this coordinator fixture only observes kill and exited.
      sprout: { kill() {}, exited: never } as Bun.Subprocess,
      sproutPath: input.sourcePath,
      artifactDir: `${input.sourcePath}-${port}`,
      // SAFETY: the fixture never calls broker methods.
      broker: {} as Running["broker"],
      stopBroker: () => server.stop(),
      expected: false,
      port,
      enableDispatch() {},
      disableDispatch() {},
    };
  };
  const rebuild = async () => {
    // SAFETY: the test writes both fields in configPath immediately above.
    const parsed = JSON.parse(await Bun.file(configPath).text()) as { main: string; version: string };
    const sourcePath = join(projectDir, parsed.main);
    return {
      config: { ...config, vars: { VERSION: parsed.version } },
      sourcePath,
      source: await Bun.file(sourcePath).text(),
    };
  };
  const initial = await rebuild();
  const task = runDev({
    projectDir,
    ...initial,
    port: publicPort,
    watch: true,
    candidateFactory: factory,
    exitOnShutdown: false,
    rebuild,
  });
  try {
    await eventually(async () =>
      expect(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text()).toContain("one"),
    );
    await writeFile(two, "two-updated");
    await writeFile(configPath, JSON.stringify({ main: "src/two.js", version: "v2" }));
    await eventually(async () =>
      expect(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text()).toContain("two-updated:v2"),
    );
    await writeFile(configPath, JSON.stringify({ main: "src/two.js", version: "v3" }));
    await eventually(async () =>
      expect(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text()).toContain("two-updated:v3"),
    );
    expect(seen.length).toBeGreaterThanOrEqual(3);
  } finally {
    process.emit("SIGTERM");
    await task;
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("dev: SIGINT during candidate readiness stops the active and candidate resources", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sproutboat-dev-"));
  const publicPort = freePort();
  const sourcePath = join(projectDir, "src/index.js");
  await mkdir(join(projectDir, "src"));
  await writeFile(sourcePath, "one");
  let starts = 0;
  let activeStops = 0;
  let candidateStops = 0;
  let candidateStarted: (() => void) | null = null;
  const candidateReady = new Promise<void>((resolve) => (candidateStarted = resolve));
  const factory: NonNullable<DevInput["candidateFactory"]> = async (input, port) => {
    starts += 1;
    const active = starts === 1;
    const server = active ? Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(input.source) }) : null;
    if (!active) candidateStarted?.();
    const never = new Promise<number>(() => undefined);
    return {
      // SAFETY: this coordinator fixture only observes kill and exited.
      sprout: { kill() {}, exited: never } as Bun.Subprocess,
      sproutPath: sourcePath,
      artifactDir: `${sourcePath}-${port}`,
      // SAFETY: the fixture never calls broker methods.
      broker: {} as Running["broker"],
      stopBroker: () => {
        server?.stop();
        if (active) activeStops += 1;
        else candidateStops += 1;
      },
      expected: false,
      port,
      enableDispatch() {},
      disableDispatch() {},
    };
  };
  const task = runDev({
    projectDir,
    config,
    sourcePath,
    source: "one",
    port: publicPort,
    watch: true,
    candidateFactory: factory,
    exitOnShutdown: false,
    rebuild: async () => ({ config, sourcePath, source: await Bun.file(sourcePath).text() }),
  });
  try {
    await eventually(async () => expect(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text()).toBe("one"));
    await writeFile(sourcePath, "two");
    await candidateReady;
    process.emit("SIGINT");
    await task;
    expect(activeStops).toBe(1);
    expect(candidateStops).toBe(1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("dev: SIGTERM during an in-flight candidate build waits for and cleans its resources", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sproutboat-dev-"));
  const publicPort = freePort();
  const sourcePath = join(projectDir, "src/index.js");
  await mkdir(join(projectDir, "src"));
  await writeFile(sourcePath, "one");
  let starts = 0;
  let activeStops = 0;
  let candidateStops = 0;
  let buildStarted!: () => void;
  let releaseBuild!: () => void;
  const started = new Promise<void>((resolve) => (buildStarted = resolve));
  const release = new Promise<void>((resolve) => (releaseBuild = resolve));
  const factory: NonNullable<DevInput["candidateFactory"]> = async (input, port) => {
    starts += 1;
    const active = starts === 1;
    const server = active ? Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(input.source) }) : null;
    if (!active) {
      buildStarted();
      await release;
    }
    const never = new Promise<number>(() => undefined);
    return {
      // SAFETY: this coordinator fixture only observes kill and exited.
      sprout: { kill() {}, exited: never } as Bun.Subprocess,
      sproutPath: sourcePath,
      artifactDir: `${sourcePath}-${port}`,
      // SAFETY: the fixture never calls broker methods.
      broker: {} as Running["broker"],
      stopBroker: () => {
        server?.stop();
        if (active) activeStops += 1;
        else candidateStops += 1;
      },
      expected: false,
      port,
      enableDispatch() {},
      disableDispatch() {},
    };
  };
  const task = runDev({
    projectDir,
    config,
    sourcePath,
    source: "one",
    port: publicPort,
    watch: true,
    candidateFactory: factory,
    exitOnShutdown: false,
    rebuild: async () => ({ config, sourcePath, source: await Bun.file(sourcePath).text() }),
  });
  try {
    await eventually(async () => expect(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text()).toBe("one"));
    await writeFile(sourcePath, "two");
    await started;
    process.emit("SIGTERM");
    releaseBuild();
    await task;
    expect(activeStops).toBe(1);
    expect(candidateStops).toBe(1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("dev: reload timing separates edit-to-ready latency from route-switch downtime", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "sproutboat-dev-"));
  const publicPort = freePort();
  const sourcePath = join(projectDir, "src/index.js");
  await mkdir(join(projectDir, "src"));
  await writeFile(sourcePath, "one");
  let clock = 0;
  const timings: Array<{ editToReadyMs: number; downtimeMs: number }> = [];
  const factory: NonNullable<DevInput["candidateFactory"]> = async (input, port) => {
    if (input.source === "two") clock = 175;
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(input.source) });
    const never = new Promise<number>(() => undefined);
    return {
      // SAFETY: this coordinator fixture only observes kill and exited.
      sprout: { kill() {}, exited: never } as Bun.Subprocess,
      sproutPath: sourcePath,
      artifactDir: `${sourcePath}-${port}`,
      // SAFETY: the fixture never calls broker methods.
      broker: {} as Running["broker"],
      stopBroker: () => server.stop(),
      expected: false,
      port,
      enableDispatch() {},
      disableDispatch() {},
    };
  };
  const task = runDev({
    projectDir,
    config,
    sourcePath,
    source: "one",
    port: publicPort,
    watch: true,
    candidateFactory: factory,
    exitOnShutdown: false,
    now: () => clock,
    onReload: (timing) => timings.push(timing),
    rebuild: async () => ({ config, sourcePath, source: await Bun.file(sourcePath).text() }),
  });
  try {
    await eventually(async () => expect(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text()).toBe("one"));
    clock = 100;
    await writeFile(sourcePath, "two");
    await eventually(() => expect(timings).toHaveLength(1));
    expect(timings[0]).toEqual({ editToReadyMs: 75, downtimeMs: 0 });
  } finally {
    process.emit("SIGTERM");
    await task;
    await rm(projectDir, { recursive: true, force: true });
  }
});
