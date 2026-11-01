import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A release bumps the platform packages in package.json and in platform-packages/*. bun.lock records them
// too, and a lock still naming the previous version breaks every frozen install after the release. The
// release skill runs `bun install` to regenerate it; this fails the release PR if that step was skipped.
const root = join(import.meta.dir, "..");
// SAFETY: this repo's own package.json, whose shape is fixed by this repo.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  optionalDependencies: Record<string, string>;
};
const lock = readFileSync(join(root, "bun.lock"), "utf8");

test("bun.lock names the platform packages at the versions package.json asks for", () => {
  const names = Object.keys(pkg.optionalDependencies).filter((name) => name.startsWith("@sproutboat/cli-"));
  expect(names).toHaveLength(4);
  for (const name of names) {
    const wanted = pkg.optionalDependencies[name];
    const seen = [...lock.matchAll(new RegExp(`"${name}": "([^"]+)"`, "g"))].map((m) => m[1]);
    expect(seen.length).toBeGreaterThan(0);
    for (const version of seen) expect(version, `${name} in bun.lock (run bun install)`).toBe(wanted);
  }
});

test("the platform packages and the CLI are one version", () => {
  // SAFETY: as above.
  const cli = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  for (const dir of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    // SAFETY: a platform package.json in this repo; it always has a version.
    const platform = JSON.parse(readFileSync(join(root, "platform-packages", dir, "package.json"), "utf8")) as {
      version: string;
    };
    expect(platform.version).toBe(cli.version);
  }
});
