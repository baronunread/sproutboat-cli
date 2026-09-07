import { expect, test } from "bun:test";
import { BASELINE_COMPATIBILITY_DATE, porfforArgs, wrapNativeFetchHandler } from "./compile";
import { DEPLOY_TARGET, hostTarget, validateManifest } from "./manifest";

test("wrap: injects prelude + env, keeps the handler body verbatim", () => {
  const out = wrapNativeFetchHandler(`export default { fetch(req) { return new Response(env.G); } };`, "/*PRELUDE*/", {
    G: "hej",
  });
  expect(out).toStartWith("/*PRELUDE*/");
  expect(out).toContain(`const env = {"G":"hej"};`);
  expect(out).toContain("return new Response(env.G);");
  // the user's default object is kept verbatim as __sbHandlers
  expect(out).toContain("const __sbHandlers = { fetch(req) { return new Response(env.G); } };");
});

test("wrap: async fetch is kept verbatim in __sbHandlers", () => {
  const out = wrapNativeFetchHandler(`export default { async fetch() { return new Response("x"); } };`, "");
  expect(out).toContain('const __sbHandlers = { async fetch() { return new Response("x"); } };');
  expect(out).toContain("fetch(request) { return __sbEntry(__sbHandlers, request); }");
});

test("wrap: rejects a non-conforming handler", () => {
  expect(() => wrapNativeFetchHandler(`export default function () {}`, "")).toThrow(/default-export an object/);
});

test("wrap: no bindings -> no __sbInstallBindings line", () => {
  const out = wrapNativeFetchHandler(`export default { fetch() { return new Response("x"); } };`, "");
  expect(out).not.toContain("__sbInstallBindings");
});

test("wrap: declared bindings emit one install line after `const env`", () => {
  const out = wrapNativeFetchHandler(
    `export default { fetch() { return new Response("x"); } };`,
    "",
    { V: "1" },
    {
      kv: ["CACHE"],
      secrets: [],
      outbound: [],
      d1: [],
      r2: [],
      queues: [],
      analytics: [],
      do: [],
      services: [],
      crons: [],
      assets: "",
    },
  );
  expect(out).toContain(`const env = {"V":"1"};\nglobalThis.env = env;\n__sbInstallBindings(env, {"kv":["CACHE"]`);
  expect(out).toContain(`fetch(request) { return __sbEntry(__sbHandlers, request); }`);
  expect(out).toContain(`const __sbHandlers = { fetch() { return new Response("x"); } };`);
});

test("wrap: an assets binding alone triggers the install line", () => {
  const out = wrapNativeFetchHandler(
    `export default { fetch() { return new Response("x"); } };`,
    "",
    {},
    {
      kv: [],
      secrets: [],
      outbound: [],
      d1: [],
      r2: [],
      queues: [],
      analytics: [],
      do: [],
      services: [],
      crons: [],
      assets: "ASSETS",
    },
  );
  expect(out).toContain(`__sbInstallBindings(env, {"kv":[]`);
  expect(out).toContain(`"assets":"ASSETS"`);
});

test("wrap: Durable Object classes are neutralised and registered", () => {
  const out = wrapNativeFetchHandler(
    `export class Counter { fetch() { return new Response("1"); } }\nexport default { fetch() { return new Response("x"); } };`,
    "",
    {},
    {
      kv: [],
      secrets: [],
      outbound: [],
      d1: [],
      r2: [],
      queues: [],
      analytics: [],
      do: [{ binding: "COUNTER", className: "Counter" }],
      services: [],
      crons: [],
      assets: "",
    },
  );
  expect(out).toContain(`\nclass Counter { fetch()`);
  expect(out).toContain(`__sbRegisterDO({ Counter: Counter });`);
});

test("prelude: crypto is CSPRNG-backed, no Math.random downgrade", async () => {
  const prelude = await Bun.file(new URL("./native-fetch-prelude.js", import.meta.url)).text();
  // the OS entropy path is wired end to end
  expect(prelude).toContain("static int sb_os_random(");
  expect(prelude).toContain('open("/dev/urandom"');
  expect(prelude).toContain("function __sbRandomBytes(");
  expect(prelude).toContain("__sbRandomBytes(String(n))");
  // and the insecure fallback is gone (issue #54)
  expect(prelude).not.toContain("Math.random");
});

/**
 * #62 — a `--target host` artifact runs on the machine that built it and
 * nowhere else. Nothing stops it reaching `deploy` except the manifest target,
 * so that rejection is the whole safety property.
 */
test("manifest: a host-target artifact is rejected as undeployable", () => {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const base = {
    schemaVersion: 2,
    project: "hello",
    runtime: "native-fetch",
    capabilityProfile: "http-sync-v0",
    porfforVersion: "alpha-4",
    esbuildVersion: "0.28.2",
    buildImage: "stamp",
    sourceHash: digest,
    binaryHash: digest,
    binarySize: 42,
    builtAt: "2026-08-26T00:00:00.000Z",
  };
  expect(validateManifest({ ...base, target: DEPLOY_TARGET }).ok).toBe(true);

  const host = validateManifest({ ...base, target: "arm64-darwin" });
  expect(host.ok).toBe(false);
  if (host.ok) throw new Error("unreachable");
  expect(host.errors.join(" ")).toContain("arm64-darwin");
  expect(host.errors.join(" ")).toContain("--target host");
});

test("hostTarget names this machine, and is never the deploy target", () => {
  expect(hostTarget()).toBe(`${process.arch}-${process.platform}`);
  expect(hostTarget()).not.toBe(DEPLOY_TARGET);
});

test("wrap: bakes the compatibility date, defaulting to the baseline", () => {
  const handler = `export default { fetch() { return new Response("x"); } };`;
  const pinned = wrapNativeFetchHandler(handler, "", {}, undefined, undefined, "2026-11-02");
  expect(pinned).toContain(`globalThis.__sbCompat = "2026-11-02";`);
  // An artifact built without one keeps the semantics of the baseline day,
  // which is what an old manifest with no compatibilityDate means.
  expect(wrapNativeFetchHandler(handler, "")).toContain(`globalThis.__sbCompat = "${BASELINE_COMPATIBILITY_DATE}";`);
});

test("manifest: compatibilityDate is optional, and validated when present", () => {
  const base = {
    schemaVersion: 2,
    project: "hello",
    target: DEPLOY_TARGET,
    runtime: "native-fetch",
    capabilityProfile: "http-sync-v0",
    porfforVersion: "alpha-4",
    esbuildVersion: "0.28.2",
    buildImage: "zig-musl/0.16.0",
    sourceHash: `sha256:${"a".repeat(64)}`,
    binaryHash: `sha256:${"b".repeat(64)}`,
    binarySize: 420_000,
    builtAt: new Date().toISOString(),
  };
  // An artifact from before the field existed stays deployable — this is the
  // case that must never regress, or rollback stops working.
  const old = validateManifest(base);
  expect(old.ok).toBe(true);
  if (old.ok) expect(old.value.compatibilityDate).toBeUndefined();

  const dated = validateManifest({ ...base, compatibilityDate: "2026-11-02" });
  expect(dated.ok).toBe(true);
  if (dated.ok) expect(dated.value.compatibilityDate).toBe("2026-11-02");

  const bad = validateManifest({ ...base, compatibilityDate: "Nov 2 2026" });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.errors).toContain("compatibilityDate must be YYYY-MM-DD");
});

// -O0 roughly triples build speed (8.4s -> 2.9s for examples/hello) and grows
// the binary by about half, so it is for `dev` only. The risk worth pinning is
// that it never reaches something a user could ship.
test("porfforArgs: dev host builds take -O0", () => {
  expect(porfforArgs("/t/m.js", "/t/out", "host", "dev")).toEqual(["native", "/t/m.js", "-o", "/t/out", "-s", "-O0"]);
});

test("porfforArgs: a deployable build is never -O0", () => {
  // The deploy target, however it is asked for.
  expect(porfforArgs("/t/m.js", "/t/out", "linux-x86_64", "dev")).not.toContain("-O0");
  expect(porfforArgs("/t/m.js", "/t/out", "linux-x86_64", "release")).not.toContain("-O0");
  expect(porfforArgs("/t/m.js", "/t/out", "linux-x86_64", undefined)).not.toContain("-O0");
  // And a host build that did not ask for the fast path.
  expect(porfforArgs("/t/m.js", "/t/out", "host", "release")).not.toContain("-O0");
  expect(porfforArgs("/t/m.js", "/t/out", "host", undefined)).not.toContain("-O0");
});

test("porfforArgs: --musl marks the cross-compile, and only that", () => {
  expect(porfforArgs("/t/m.js", "/t/out", "linux-x86_64", "release")).toContain("--musl");
  expect(porfforArgs("/t/m.js", "/t/out", "host", "release")).not.toContain("--musl");
});
