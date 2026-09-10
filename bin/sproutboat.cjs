#!/usr/bin/env node
// npm only selects the packaged executable. The CLI itself always runs in Bun.
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!platform || !arch) {
  console.error(`sproutboat: unsupported platform ${process.platform}/${process.arch}`);
  process.exit(1);
}
const packageName = `@sproutboat/cli-${platform}-${arch}`;
let executable;
try {
  executable = require.resolve(`${packageName}/bin/sproutboat`);
} catch {
  console.error(`sproutboat: optional package ${packageName} is missing for ${platform}/${arch}`);
  console.error("Reinstall sproutboat without --omit=optional, or use a direct release download.");
  process.exit(1);
}
const child = spawn(resolve(executable), process.argv.slice(2), { stdio: "inherit" });
child.once("error", (error) => {
  console.error(`sproutboat: could not start bundled executable: ${error.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
