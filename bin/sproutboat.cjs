#!/usr/bin/env node
// npm only selects the packaged executable. The CLI itself always runs in Bun.
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!platform || !arch) {
  console.error(`sproutboat: unsupported platform ${process.platform}/${process.arch}`);
  process.exit(1);
}
const executable = join(
  __dirname,
  "platform",
  `${platform}-${arch}`,
  platform === "win32" ? "sproutboat.exe" : "sproutboat",
);
if (!existsSync(executable)) {
  console.error(`sproutboat: this npm package has no binary for ${platform}/${arch}`);
  console.error("Install a supported platform package or use a direct release download.");
  process.exit(1);
}
const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });
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
