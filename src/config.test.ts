import { expect, test } from "bun:test";
import { parseConfig } from "./config";

const base = `{ "name": "app", "main": "src/index.js", "compatibility_date": "2026-08-26"`;

test("accepts kv_namespaces / secrets / outbound / d1_databases / r2_buckets and passes them through", () => {
  const r = parseConfig(
    `${base}, "kv_namespaces": ["CACHE"], "secrets": ["API_KEY"], "outbound": ["api.example.com"], "d1_databases": ["DB"], "r2_buckets": ["ASSETS"] }`,
  );
  expect(r.ok && r.value).toMatchObject({
    kv_namespaces: ["CACHE"],
    secrets: ["API_KEY"],
    outbound: ["api.example.com"],
    d1_databases: ["DB"],
    r2_buckets: ["ASSETS"],
  });
});

test("binding names must be UPPER_SNAKE_CASE", () => {
  const r = parseConfig(`${base}, "kv_namespaces": ["cache"] }`);
  expect(r.ok).toBe(false);
});

test("outbound entries must look like hostnames", () => {
  expect(parseConfig(`${base}, "outbound": ["https://api.example.com"] }`).ok).toBe(false);
  expect(parseConfig(`${base}, "outbound": ["localhost"] }`).ok).toBe(false);
});

test("a var and a binding may not share a name (any binding kind)", () => {
  expect(parseConfig(`${base}, "vars": { "TOKEN": "x" }, "secrets": ["TOKEN"] }`).ok).toBe(false);
  expect(parseConfig(`${base}, "d1_databases": ["DB"], "r2_buckets": ["DB"] }`).ok).toBe(false);
  const r = parseConfig(`${base}, "kv_namespaces": ["X"], "d1_databases": ["X"] }`);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("must not collide");
});

test("assets: accepts a full block and passes it through", () => {
  const r = parseConfig(
    `${base}, "assets": { "directory": "./public/", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_sprout_first": ["/api/*", "!/api/docs/*"] } }`,
  );
  expect(r.ok && r.value.assets).toEqual({
    directory: "public",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_sprout_first: ["/api/*", "!/api/docs/*"],
  });
});

test("assets: directory required, binding UPPER_SNAKE, enum + pattern checks, no collision", () => {
  expect(parseConfig(`${base}, "assets": { "binding": "ASSETS" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "../etc" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "public", "binding": "assets" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "public", "not_found_handling": "spa" } }`).ok).toBe(false);
  expect(parseConfig(`${base}, "assets": { "directory": "public", "run_sprout_first": ["api/*"] } }`).ok).toBe(false);
  const collide = parseConfig(`${base}, "kv_namespaces": ["ASSETS"], "assets": { "directory": "public", "binding": "ASSETS" } }`);
  expect(collide.ok).toBe(false);
  if (!collide.ok) expect(collide.errors.join(" ")).toContain("must not collide");
});

test("assets: bare directory (edge-only, no binding) is valid", () => {
  const r = parseConfig(`${base}, "assets": { "directory": "public" } }`);
  expect(r.ok && r.value.assets).toEqual({ directory: "public" });
});

test("omitting the binding fields is still valid", () => {
  const r = parseConfig(`${base} }`);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.kv_namespaces).toBeUndefined();
});
