import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { jsonObject, parseJsonValue } from "../../src/json";
import { Harness, HarnessFailure, readDeadline } from "./harness";

const server = new URL("./fixtures/fault-server.ts", import.meta.url).pathname;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const freePort = () => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
};
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup({ descendants: false });
});
function start(mode: string, options: ConstructorParameters<typeof Harness>[0]) {
  const harness = new Harness({ handleSignals: false, announceSteps: false, ...options });
  harnesses.push(harness);
  const port = freePort();
  const child = harness.spawn("fault-server", [process.execPath, server, mode], {
    env: { ...process.env, PORT: String(port) },
  });
  return { harness, child, base: `http://127.0.0.1:${port}` };
}

test("a server that never completes a body fails at the deadline and cleans up", async () => {
  const { harness, child, base } = start("stall", {
    backend: "fixture-stall",
    requestTimeoutMs: 500,
    secrets: ["hunter2-secret"],
  });
  await harness.waitReady(base + "/");
  harness.step("download the object");
  const started = performance.now();
  const failure = await harness.fetch(base + "/body").then(
    () => undefined,
    (error) => error,
  );
  expect(performance.now() - started).toBeLessThan(3000);
  expect(failure).toBeInstanceOf(HarnessFailure);
  expect(failure.kind).toBe("request-timeout");
  expect(failure.step).toBe("download the object");
  const report = harness.report(failure);
  expect(report).toContain("step:     download the object");
  expect(report).toContain("backend:  fixture-stall");
  expect(report).toMatch(/versions: cli \S+, runtime \S+, toolchain \S+/);
  expect(report).toContain("fault-server listening");

  const pid = child.pid;
  const workdir = harness.workdir;
  await harness.cleanup({ descendants: false });
  expect(alive(pid)).toBe(false);
  expect(existsSync(workdir)).toBe(false);
});

test("a native child that exits during a request fails promptly with its stderr, secrets removed", async () => {
  const { harness, child, base } = start("exit", {
    backend: "fixture-exit",
    requestTimeoutMs: 20_000,
    secrets: ["hunter2-secret"],
  });
  await harness.waitReady(base + "/");
  harness.step("request that kills the child");
  const started = performance.now();
  const failure = await harness.fetch(base + "/body").then(
    () => undefined,
    (error) => error,
  );
  // far below the 20 s request deadline: the exit ends the wait
  expect(performance.now() - started).toBeLessThan(3000);
  expect(failure).toBeInstanceOf(HarnessFailure);
  expect(failure.kind).toBe("child-exited");
  expect(failure.message).toContain("exited with code 7");
  await child.exited;
  await Bun.sleep(50);
  const report = harness.report(failure);
  expect(report).toContain("fatal: lost connection using token [redacted]");
  expect(report).not.toContain("hunter2-secret");
  const workdir = harness.workdir;
  await harness.cleanup({ descendants: false });
  expect(existsSync(workdir)).toBe(false);
});

test("a raw socket exchange has a deadline too", async () => {
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const harness = new Harness({
    backend: "fixture-raw",
    handleSignals: false,
    announceSteps: false,
    requestTimeoutMs: 300,
  });
  harnesses.push(harness);
  try {
    harness.step("HTTP/1.0 request");
    const failure = await harness.rawExchange("127.0.0.1", silent.port, "GET / HTTP/1.0\r\n\r\n").then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(HarnessFailure);
    expect(failure.kind).toBe("request-timeout");
    expect(failure.step).toBe("HTTP/1.0 request");
  } finally {
    silent.stop(true);
  }
});

test("a slow build fails as a build timeout, not as a request timeout", async () => {
  const harness = new Harness({
    backend: "fixture-build",
    handleSignals: false,
    announceSteps: false,
    buildTimeoutMs: 200,
  });
  harnesses.push(harness);
  const failure = await harness
    .build("compiling the sprout", () => Bun.sleep(5000))
    .then(
      () => undefined,
      (error) => error,
    );
  expect(failure.kind).toBe("build-timeout");
  expect(failure.step).toBe("compiling the sprout");
});

test("a child that never listens fails as a readiness timeout", async () => {
  const harness = new Harness({
    backend: "fixture-ready",
    handleSignals: false,
    announceSteps: false,
    readyTimeoutMs: 300,
  });
  harnesses.push(harness);
  const failure = await harness.waitReady(`http://127.0.0.1:${freePort()}/`).then(
    () => undefined,
    (error) => error,
  );
  expect(failure.kind).toBe("ready-timeout");
});

test("an interrupted run stops its child and removes its temp dir", async () => {
  const port = freePort();
  const run = Bun.spawn(
    [process.execPath, new URL("./fixtures/interrupted-run.ts", import.meta.url).pathname, String(port)],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = run.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    line += new TextDecoder().decode(value);
  }
  const started = jsonObject(parseJsonValue(line));
  const pid = Number(started?.pid);
  const workdir = String(started?.workdir);
  expect(alive(pid)).toBe(true);
  expect(existsSync(workdir)).toBe(true);
  run.kill("SIGTERM");
  expect(await run.exited).toBe(143);
  await Bun.sleep(100);
  expect(alive(pid)).toBe(false);
  expect(existsSync(workdir)).toBe(false);
  expect(await new Response(run.stderr).text()).toContain(
    "interrupted (SIGTERM) during step: download (never completes)",
  );
});

test("deadline environment variables are validated", () => {
  expect(readDeadline("X", 5, { X: "250" })).toBe(250);
  expect(readDeadline("X", 5, {})).toBe(5);
  expect(() => readDeadline("X", 5, { X: "soon" })).toThrow("X must be a positive integer");
});
