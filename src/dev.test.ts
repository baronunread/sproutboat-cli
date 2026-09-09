import { expect, test } from "bun:test";
import { isAssetOnlyRefresh, tcpReady, type DevInput } from "./dev";

// SAFETY: this fixture supplies every required parsed configuration field.
const config = {
  name: "hello",
  main: "src/index.js",
  compatibility_date: "2026-08-26",
} as DevInput["config"];

test("dev: asset-only refresh reuses the native sprout, source/config changes do not", () => {
  const current = { config, source: "export default { fetch() {} }" };
  expect(isAssetOnlyRefresh(current, { ...current })).toBe(true);
  expect(
    isAssetOnlyRefresh(current, { ...current, source: "export default { fetch() { return new Response() } }" }),
  ).toBe(false);
  expect(isAssetOnlyRefresh(current, { ...current, config: { ...config, vars: { VERSION: "2" } } })).toBe(false);
});

test("dev: TCP readiness has a bounded failure path without invoking an application route", async () => {
  // Port 1 is deliberately not a test server. This verifies the coordinator's
  // non-HTTP readiness primitive returns rather than waiting on user code.
  expect(await tcpReady(1, 25)).toBe(false);
});
