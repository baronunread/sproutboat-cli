import { expect, test } from "bun:test";
import { isLinuxTarget, linuxTriple, parseTarget } from "./targets";
import { porfforArgs } from "./compile";

test("--target names resolve to a build target, aliases included", () => {
  expect(parseTarget("host")).toBe("host");
  for (const name of ["linux-x64", "linux-x86_64", "linux-amd64", "x86_64-linux"])
    expect(parseTarget(name)).toBe("linux-x86_64");
  for (const name of ["linux-arm64", "linux-aarch64", "aarch64-linux"]) expect(parseTarget(name)).toBe("linux-arm64");
  expect(parseTarget("windows")).toBeUndefined();
  expect(parseTarget(undefined)).toBeUndefined();
});

test("each Linux target compiles with its own static musl triple", () => {
  expect(linuxTriple("linux-x86_64")).toBe("x86_64-linux-musl");
  expect(linuxTriple("linux-arm64")).toBe("aarch64-linux-musl");
  expect(linuxTriple(undefined)).toBe("x86_64-linux-musl");
  expect(isLinuxTarget("linux-arm64")).toBe(true);
  expect(isLinuxTarget("host")).toBe(false);
});

test("an arm64 build is a cross-compile and never takes the dev-only -O0", () => {
  const args = porfforArgs("/t/m.js", "/t/out", "linux-arm64", "dev");
  expect(args).toContain("--musl");
  expect(args).not.toContain("-O0");
});

test("the uSockets listen hook is added once, to the real bsd.c of the pinned uWebSockets", async () => {
  const { mkdtemp, mkdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { patchUSocketsListenHook } = await import("./toolchain");
  const dir = await mkdtemp(join(tmpdir(), "sb-usockets-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    const archive = join(import.meta.dir, "..", "vendor", "uwebsockets-360c276d-musl.tar.xz");
    const untar = Bun.spawnSync([
      "tar",
      "-xJf",
      archive,
      "-C",
      dir,
      "--strip-components=3",
      "--include=*/uSockets/src/bsd.c",
    ]);
    expect(untar.exitCode).toBe(0);
    const bsd = join(dir, "bsd.c");
    await Bun.write(join(dir, "src", "bsd.c"), await readFile(bsd));
    await patchUSocketsListenHook(dir);
    const once = await readFile(join(dir, "src", "bsd.c"), "utf8");
    expect(once).toContain("sb_inherited_listen_fd(host, port)");
    // The hook is the first thing the function does, before it creates a socket.
    expect(once.indexOf("sb_inherited_listen_fd(host, port)")).toBeLessThan(
      once.indexOf("getaddrinfo", once.indexOf("bsd_create_listen_socket(")),
    );
    await patchUSocketsListenHook(dir);
    expect(await readFile(join(dir, "src", "bsd.c"), "utf8")).toBe(once);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
