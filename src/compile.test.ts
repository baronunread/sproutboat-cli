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
  expect(out).toContain("fetch(req) {");
});

test("wrap: async fetch and default param name", () => {
  const out = wrapNativeFetchHandler(`export default { async fetch() { return new Response("x"); } };`, "");
  expect(out).toContain("async fetch(request) {");
});

test("wrap: rejects a non-conforming handler", () => {
  expect(() => wrapNativeFetchHandler(`export default function () {}`, "")).toThrow(/default-export an object/);
});
