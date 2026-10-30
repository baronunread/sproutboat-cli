/**
 * The machines a binary can be built for.
 *
 * `linux-x86_64` is the deploy target (static musl, the one `deploy` accepts). `linux-arm64` is the
 * same static musl build for an aarch64 box (a Raspberry Pi, Graviton, Ampere, an Apple-silicon
 * Linux VM) and exists for `--standalone` only: the platform runs x86_64. `host` is this machine.
 */
export type LinuxTarget = "linux-x86_64" | "linux-arm64";
export type BuildTarget = LinuxTarget | "host";

type LinuxInfo = {
  /** Zig and uSockets name for the architecture. */
  arch: "x86_64" | "aarch64";
  /** The Zig target triple: a static binary needs no libc on the box. */
  triple: string;
  /** Container platform for `docker --platform`. */
  platform: "linux/amd64" | "linux/arm64";
};

export const LINUX_TARGETS = {
  "linux-x86_64": { arch: "x86_64", triple: "x86_64-linux-musl", platform: "linux/amd64" },
  "linux-arm64": { arch: "aarch64", triple: "aarch64-linux-musl", platform: "linux/arm64" },
} satisfies Record<LinuxTarget, LinuxInfo>;

const ALIASES = new Map<string, BuildTarget>([
  ["host", "host"],
  ["linux-x86_64", "linux-x86_64"],
  ["linux-x64", "linux-x86_64"],
  ["linux-amd64", "linux-x86_64"],
  ["x86_64-linux", "linux-x86_64"],
  ["linux-arm64", "linux-arm64"],
  ["linux-aarch64", "linux-arm64"],
  ["aarch64-linux", "linux-arm64"],
]);

/** `--target` value to a build target; undefined when it names none. */
export function parseTarget(value: string | undefined): BuildTarget | undefined {
  return value === undefined ? undefined : ALIASES.get(value);
}

export const TARGET_NAMES = "host | linux-x64 | linux-arm64";

export function isLinuxTarget(target: BuildTarget): target is LinuxTarget {
  return target !== "host";
}

/** The Zig triple for a Linux target; x86_64 for anything else, which is what Porffor builds by default. */
export function linuxTriple(target: BuildTarget | undefined): string {
  return LINUX_TARGETS[target === "linux-arm64" ? "linux-arm64" : "linux-x86_64"].triple;
}
