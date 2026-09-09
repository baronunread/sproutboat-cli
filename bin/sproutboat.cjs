#!/usr/bin/env node
// npm only selects the packaged executable. The CLI itself always runs in Bun.
const { spawnSync } = require("node:child_process");
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
const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`sproutboat: could not start bundled executable: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
