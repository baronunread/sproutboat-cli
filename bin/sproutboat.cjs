#!/usr/bin/env node
// npm selects the packaged executable for this host when it is installed; that
// is a native single-file binary that needs no Bun. When it is absent (it is
// not published yet — see issue #134), fall back to running the TypeScript
// entry point with Bun, which is how the CLI shipped through v0.9.0.
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;

let command;
let args;
let viaBun = false;
try {
  if (!platform || !arch) throw new Error(`unsupported host ${process.platform}/${process.arch}`);
  command = require.resolve(`@sproutboat/cli-${platform}-${arch}/bin/sproutboat`);
  args = process.argv.slice(2);
} catch {
  viaBun = true;
  // SPROUTBOAT_BUN is an escape hatch for an unusual install; otherwise PATH.
  command = process.env.SPROUTBOAT_BUN || "bun";
  args = [join(__dirname, "..", "src", "main.ts"), ...process.argv.slice(2)];
}

const child = spawn(command, args, { stdio: "inherit", windowsHide: true });

child.once("error", (error) => {
  if (viaBun && error.code === "ENOENT") {
    console.error("sproutboat: this build needs Bun on PATH. Install it: https://bun.sh");
  } else {
    console.error(`sproutboat: could not start: ${error.message}`);
  }
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("exit", (code, signal) => {
  if (signal) {
    // Re-raise so the parent's exit reflects the signal — but drop our own
    // handler first, or the re-raise re-enters it and the process hangs.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
