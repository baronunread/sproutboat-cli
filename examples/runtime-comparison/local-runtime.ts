#!/usr/bin/env bun
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// Isolated CLI copy with a local runtime dependency. No installed package or
// lockfile is modified, and the manifest identifies this unreleased override.
const here = import.meta.dir;
const cli = resolve(here, "../..");
const runtime = resolve(cli, "../sproutboat-packages/packages/runtime");
const toolchain = resolve(cli, "../sproutboat-packages/packages/toolchain");
const work = mkdtempSync(join(tmpdir(), "sb-comparison-local-"));
try {
  cpSync(join(cli, "src"), join(work, "src"), { recursive: true });
  cpSync(join(cli, "package.json"), join(work, "package.json"));
  cpSync(join(cli, "examples"), join(work, "examples"), {
    recursive: true,
    filter: (path) => !["results", ".sproutboat", "dist", "node_modules"].includes(basename(path)),
  });
  for (const name of [
    "types",
    "scripts",
    "vendor",
    "bin",
    "fixtures",
    "platform-packages",
    "SURFACE.md",
    "CONTRACTS.md",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    cpSync(join(cli, name), join(work, name), { recursive: true });
  }
  mkdirSync(join(work, "node_modules/@sproutboat"), { recursive: true });
  for (const name of readdirSync(join(cli, "node_modules"))) {
    if (name === "@sproutboat") continue;
    symlinkSync(join(cli, "node_modules", name), join(work, "node_modules", name));
  }
  for (const name of readdirSync(join(cli, "node_modules/@sproutboat"))) {
    symlinkSync(
      name === "runtime" ? runtime : name === "toolchain" ? toolchain : join(cli, "node_modules/@sproutboat", name),
      join(work, "node_modules/@sproutboat", name),
    );
  }
  const { ensurePorffor } = await import("../../src/porffor-toolchain");
  const compiler = await ensurePorffor();
  const isolatedCompiler = join(work, "porffor");
  cpSync(compiler, isolatedCompiler, { recursive: true });
  const localEnv = {
    ...process.env,
    COMPARISON_LOCAL_RUNTIME: runtime,
    COMPARISON_LOCAL_TOOLCHAIN: toolchain,
    SPROUTBOAT_PORFFOR_DIR: isolatedCompiler,
  };
  const child = Bun.spawn(
    [
      process.execPath,
      join(
        work,
        process.argv.includes("--prepare-linux")
          ? "examples/runtime-comparison/linux/prepare.ts"
          : process.argv.includes("--repro")
            ? "examples/runtime-comparison/repro-ingress.ts"
            : "examples/runtime-comparison/run.ts",
      ),
    ],
    {
      cwd: work,
      env: localEnv,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await child.exited;
  cpSync(join(work, "examples/runtime-comparison/results"), join(here, "results"), { recursive: true });
  if (process.argv.includes("--verify")) {
    for (const command of [
      ["test", "src/"],
      ["examples/kitchen-sink/harness.ts"],
      ["examples/kitchen-sink/harness-standalone.ts"],
      ["run", "examples"],
    ]) {
      const check = Bun.spawn([process.execPath, ...command], {
        cwd: work,
        env: localEnv,
        stdout: "inherit",
        stderr: "inherit",
      });
      const code = await check.exited;
      if (code !== 0) process.exitCode = code;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
