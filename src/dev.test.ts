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
