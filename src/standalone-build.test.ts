import { expect, test } from "bun:test";
import { unsupportedBindings } from "./standalone-build";

test("service bindings cannot work in a standalone binary", () => {
  // They call another deployment through an edge, and a standalone binary has
  // none — so this is a build error rather than a runtime surprise.
  const blocked = unsupportedBindings({ services: [{ binding: "AUTH", service: "auth-api" }] });
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toContain("edge");
});

test("outbound does not block a build", () => {
  // http:// works on the embedded backend and https reports at runtime, so a
  // project that only talks to its own network still builds.
  expect(unsupportedBindings({ outbound: ["api.example.com"] })).toEqual([]);
});

test("a project with no bindings at all is fine", () => {
  expect(unsupportedBindings({})).toEqual([]);
});
