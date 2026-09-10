import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const npm = Bun.which("npm");
const node = Bun.which("node");
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Command = { code: number; stdout: string; stderr: string };
async function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<Command> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function pack(directory: string, destination: string): Promise<string> {
  if (!npm) throw new Error("npm is required for package tests");
  const result = await run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], directory);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  // SAFETY: npm pack's --json response is an array with a filename string.
  const filename = (JSON.parse(result.stdout) as Array<{ filename: string }>)[0]?.filename;
  if (!filename) throw new Error(`npm pack did not return a filename: ${result.stdout}`);
  return join(destination, filename);
}

async function fixtures(): Promise<{
  directory: string;
  rootTarball: string;
  platformTarball: string;
  packageName: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "sproutboat npm package "));
  temporary.push(directory);
  const packageName = `@sproutboat/cli-${process.platform}-${process.arch}`;
  const release = "0.0.0-test";
  const rootPackage = join(directory, "root");
  const platformPackage = join(directory, "platform");
  const tarballs = join(directory, "tarballs");
  await mkdir(join(rootPackage, "bin"), { recursive: true });
  await mkdir(join(platformPackage, "bin"), { recursive: true });
  await mkdir(tarballs);
  await cp(join(root, "bin", "sproutboat.cjs"), join(rootPackage, "bin", "sproutboat.cjs"));
  await writeFile(
    join(rootPackage, "package.json"),
    JSON.stringify({
      name: "sproutboat",
      version: release,
      bin: { sproutboat: "bin/sproutboat.cjs" },
      optionalDependencies: { [packageName]: release },
    }),
  );
  await writeFile(
    join(platformPackage, "package.json"),
    JSON.stringify({
      name: packageName,
      version: release,
      os: [process.platform],
      cpu: [process.arch],
      files: ["bin/sproutboat"],
    }),
  );
  await writeFile(
    join(platformPackage, "bin", "sproutboat"),
    '#!/bin/sh\nif [ "$1" = wait ]; then : > "$SB_TEST_READY"; trap \'exit 77\' INT TERM; while :; do sleep 1; done; fi\nprintf \'%s\\n\' "$@"\nif [ "$1" = exit ]; then exit "$2"; fi\n',
  );
  await chmod(join(platformPackage, "bin", "sproutboat"), 0o755);
  return {
    directory,
    rootTarball: await pack(rootPackage, tarballs),
    platformTarball: await pack(platformPackage, tarballs),
    packageName,
  };
}

test("root npm pack excludes platform binaries and retains runtime exports", async () => {
  if (!npm) throw new Error("npm is required for package tests");
  const result = await run(npm, ["pack", "--json", "--ignore-scripts", "--dry-run"], root);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  // SAFETY: npm pack's --json response is an array with a files array.
  const files =
    (JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>)[0]?.files.map((file) => file.path) ?? [];
  expect(files).toContain("bin/sproutboat.cjs");
  expect(files).toContain("src/broker.ts");
  expect(files.some((file) => file.includes("platform/") || file.includes("platform-packages/"))).toBe(false);
}, 120000);

test("root optional dependencies and platform package constraints cover the release matrix", async () => {
  // SAFETY: package manifests in this repository are JSON owned by this test.
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
    optionalDependencies: Record<string, string>;
  };
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ]) {
    const name = `@sproutboat/cli-${platform}-${arch}`;
    expect(manifest.optionalDependencies[name]).toBe(manifest.version);
    // SAFETY: platform package manifests in this repository are JSON owned by this test.
    const platformManifest = JSON.parse(
      await readFile(join(root, "platform-packages", `${platform}-${arch}`, "package.json"), "utf8"),
    ) as { name: string; version: string; os: string[]; cpu: string[]; files: string[] };
    expect(platformManifest).toMatchObject({
      name,
      version: manifest.version,
      os: [platform],
      cpu: [arch],
      files: ["bin/sproutboat"],
    });
  }
});

test("npm local, global, and exec installs resolve an optional platform tarball", async () => {
  if (!npm || !node) throw new Error("npm and node are required for package tests");
  const fixture = await fixtures();
  const project = join(fixture.directory, "project with spaces");
  const prefix = join(fixture.directory, "global prefix with spaces");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  const install = await run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", fixture.rootTarball, fixture.platformTarball],
    project,
  );
  expect(install).toMatchObject({ code: 0 });
  const local = await run(node, [join(project, "node_modules", ".bin", "sproutboat"), "one", "two"], project, {
    PATH: dirname(node),
  });
  expect(local).toEqual({ code: 0, stdout: "one\ntwo\n", stderr: "" });
  const exited = await run(node, [join(project, "node_modules", ".bin", "sproutboat"), "exit", "23"], project);
  expect(exited.code).toBe(23);
  const exec = await run(npm, ["exec", "--", "sproutboat", "exec"], project);
  expect(exec).toEqual({ code: 0, stdout: "exec\n", stderr: "" });

  const global = await run(
    npm,
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      fixture.rootTarball,
      fixture.platformTarball,
    ],
    project,
  );
  expect(global).toMatchObject({ code: 0 });
  const globalRun = await run(node, [join(prefix, "bin", "sproutboat"), "global"], project);
  expect(globalRun).toEqual({ code: 0, stdout: "global\n", stderr: "" });
}, 120000);

test("launcher forwards termination and explains missing or unsupported platforms", async () => {
  if (!node) throw new Error("node is required for package tests");
  const fixture = await fixtures();
  const project = join(fixture.directory, "signal project");
  await mkdir(project);
  const installed = join(fixture.directory, "with-platform", "node_modules");
  await mkdir(join(installed, "@sproutboat"), { recursive: true });
  await cp(join(fixture.directory, "root"), join(installed, "sproutboat"), { recursive: true });
  await cp(join(fixture.directory, "platform"), join(installed, "@sproutboat", basename(fixture.packageName)), {
    recursive: true,
  });
  const launcher = join(installed, "sproutboat", "bin", "sproutboat.cjs");
  const ready = join(fixture.directory, "child-ready");
  const child = Bun.spawn([node, launcher, "wait"], {
    cwd: project,
    env: { ...process.env, SB_TEST_READY: ready },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts++) await Bun.sleep(10);
  expect(existsSync(ready)).toBe(true);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(77);

  const missing = await run(node, [join(fixture.directory, "root", "bin", "sproutboat.cjs")], project);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain(`optional package ${fixture.packageName} is missing`);
  const unsupported = await run(
    node,
    [
      "-e",
      `Object.defineProperty(process, 'platform', { value: 'freebsd' }); require(${JSON.stringify(join(fixture.directory, "root", "bin", "sproutboat.cjs"))})`,
    ],
    project,
  );
  expect(unsupported.code).toBe(1);
  expect(unsupported.stderr).toContain("unsupported platform freebsd/");
}, 120000);
