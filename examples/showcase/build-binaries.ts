#!/usr/bin/env bun
/**
 * Build this page as standalone binaries, measure them, and write binaries/binaries.json for build-web.ts.
 *
 *   bun run binaries            linux-x64, linux-arm64 and this machine
 *   bun run binaries linux-x64  only the named targets (linux-x64, linux-arm64, host)
 *
 * The sizes on the page are these files' real sizes and checksums. The start time is how long the binary built
 * for this machine takes, from being spawned to its first /healthz answer, measured ten times.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebUi } from "./build-web";
import { freePort } from "./run-server";

const HERE = import.meta.dir;
const CLI = join(HERE, "../../src/main.ts");
const OUT = join(HERE, "binaries");

const hostTarget = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const LABELS = {
  "linux-x64": "Linux, x86-64",
  "linux-arm64": "Linux, arm64",
  "darwin-arm64": "macOS, Apple silicon",
} satisfies Record<string, string>;
const requested = process.argv.slice(2);
const targets = requested.length ? requested : ["linux-x64", "linux-arm64", "host"];

// #region build
// One command per target. --standalone puts SQLite and the page's files inside the executable,
// --release links it with LTO (the build you would publish), -c picks the standalone config.
function build(target: string): string {
  const args = [
    "build",
    HERE,
    "-c",
    join(HERE, "sproutboat.standalone.jsonc"),
    "--standalone",
    "--release",
    "--target",
    target,
  ];
  const done = Bun.spawnSync(["bun", CLI, ...args], { stdout: "inherit", stderr: "inherit" });
  if (done.exitCode !== 0) throw new Error(`build for ${target} failed`);
  return join(HERE, "dist", "showcase");
}
// #endregion

interface ColdStart {
  target: string;
  runs: number[];
  /** The first start of a file the machine has not run before (it scans it), and the median of the rest. */
  firstMs: number | undefined;
  laterMedianMs: number | undefined;
  host: string;
  date: string;
  note: string;
}

async function firstResponseMs(binary: string): Promise<number> {
  const data = mkdtempSync(join(tmpdir(), "showcase-cold-"));
  const port = freePort();
  const started = performance.now();
  const child = Bun.spawn([binary], {
    env: { ...process.env, PORT: String(port), SB_DATA_DIR: data },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (;;) {
      if (child.exitCode !== null) throw new Error("the binary exited before it answered");
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return performance.now() - started;
      } catch {}
      await Bun.sleep(1);
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    rmSync(data, { recursive: true, force: true });
  }
}

await buildWebUi(); // site-standalone/ must exist: the binaries carry it
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const files: { name: string; target: string; label: string; bytes: number; sha256: string }[] = [];
let cold: ColdStart | undefined;
for (const requestedTarget of targets) {
  const target = requestedTarget === "host" ? hostTarget : requestedTarget;
  if (files.some((file) => file.target === target)) continue;
  const built = build(requestedTarget === "linux-x64" || requestedTarget === "linux-arm64" ? requestedTarget : "host");
  if (!existsSync(built)) throw new Error(`${built} was not written`);
  const name = `showcase-${target}`;
  cpSync(built, join(OUT, name));
  files.push({
    name,
    target,
    label: Object.entries(LABELS).find(([key]) => key === target)?.[1] ?? target,
    bytes: statSync(join(OUT, name)).size,
    sha256: createHash("sha256")
      .update(readFileSync(join(OUT, name)))
      .digest("hex"),
  });
  if (target === hostTarget) {
    const runs: number[] = [];
    for (let i = 0; i < 10; i++) runs.push(Math.round(await firstResponseMs(join(OUT, name))));
    const later = runs.slice(1).sort((a, b) => a - b);
    cold = {
      target,
      runs,
      firstMs: runs[0],
      laterMedianMs: later[Math.floor(later.length / 2)],
      host: `${process.platform}-${process.arch}`,
      date: new Date().toISOString().slice(0, 10),
      note: "Spawn to the first /healthz answer, state in a fresh folder. The first run is listed apart: the machine had not run that file before.",
    };
  }
}

const cli: string = JSON.parse(readFileSync(join(HERE, "../../package.json"), "utf8")).version;
writeFileSync(
  join(OUT, "binaries.json"),
  JSON.stringify(
    { builtAt: new Date().toISOString(), cli: `sproutboat ${cli}`, host: hostTarget, release: true, files, cold },
    null,
    2,
  ) + "\n",
);
await buildWebUi(); // now with site/downloads/
console.log(files.map((file) => `${file.name}: ${(file.bytes / 1e6).toFixed(1)} MB`).join("\n"));
