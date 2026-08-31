import { expect, test } from "bun:test";
import { wrapNativeFetchHandler } from "./compile";

test("wrap: injects prelude + env, keeps the handler body verbatim", () => {
  const out = wrapNativeFetchHandler(
    `export default { fetch(req) { return new Response(env.G); } };`,
    "/*PRELUDE*/",
    { G: "hej" },
  );
  expect(out).toStartWith("/*PRELUDE*/");
  expect(out).toContain(`const env = {"G":"hej"};`);
  expect(out).toContain("return new Response(env.G);");
  // the user's default object is kept verbatim as __sbHandlers
  expect(out).toContain("const __sbHandlers = { fetch(req) { return new Response(env.G); } };");
});

test("wrap: async fetch is kept verbatim in __sbHandlers", () => {
  const out = wrapNativeFetchHandler(`export default { async fetch() { return new Response("x"); } };`, "");
  expect(out).toContain("const __sbHandlers = { async fetch() { return new Response(\"x\"); } };");
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
    { kv: ["CACHE"], secrets: [], outbound: [], d1: [], r2: [], queues: [], analytics: [], do: [], crons: [], assets: "" },
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
    { kv: [], secrets: [], outbound: [], d1: [], r2: [], queues: [], analytics: [], do: [], crons: [], assets: "ASSETS" },
  );
  expect(out).toContain(`__sbInstallBindings(env, {"kv":[]`);
  expect(out).toContain(`"assets":"ASSETS"`);
});

test("wrap: Durable Object classes are neutralised and registered", () => {
  const out = wrapNativeFetchHandler(
    `export class Counter { fetch() { return new Response("1"); } }\nexport default { fetch() { return new Response("x"); } };`,
    "",
    {},
    { kv: [], secrets: [], outbound: [], d1: [], r2: [], queues: [], analytics: [], do: [{ binding: "COUNTER", className: "Counter" }], crons: [], assets: "" },
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
