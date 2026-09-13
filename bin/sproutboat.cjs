#!/usr/bin/env node
// npm resolves exactly one @sproutboat/cli-<os>-<arch> optionalDependency for
// this host at install time (#134); this launcher just execs that native
// single-file binary. No Bun, no fallback: a platform with no published
// binary means npm skipped that optional dependency, and require.resolve
// below fails with a clear "package not found" rather than a silent one.
const { spawn } = require("node:child_process");

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;

if (!platform || !arch) {
  console.error(`sproutboat: unsupported host ${process.platform}/${process.arch}`);
  process.exit(1);
}

let command;
try {
  command = require.resolve(`@sproutboat/cli-${platform}-${arch}/bin/sproutboat`);
} catch {
  console.error(
    `sproutboat: no native build installed for ${platform}-${arch}. ` +
      `Reinstall sproutboat, or install @sproutboat/cli-${platform}-${arch} directly.`,
  );
  process.exit(1);
}

const child = spawn(command, process.argv.slice(2), { stdio: "inherit", windowsHide: true });

child.once("error", (error) => {
  console.error(`sproutboat: could not start: ${error.message}`);
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
