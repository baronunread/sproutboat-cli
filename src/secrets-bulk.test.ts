import { expect, test } from "bun:test";
import { parseBulkSecrets } from "./secrets-bulk";

test("JSON: strings set, null deletes", () => {
  const plan = parseBulkSecrets(`{ "API_KEY": "abc", "OLD_KEY": null, "DB_URL": "postgres://x" }`, "secrets.json");
  expect(plan).toEqual({ set: { API_KEY: "abc", DB_URL: "postgres://x" }, delete: ["OLD_KEY"], warnings: [] });
});

test(".env: assignments set, empty values are skipped with a warning naming the secret", () => {
  const plan = parseBulkSecrets(`# comment\nAPI_KEY=abc\nEMPTY=\nQUOTED="a b"\n`, "stdin");
  expect(plan.set).toEqual({ API_KEY: "abc", QUOTED: "a b" });
  expect(plan.delete).toEqual([]);
  expect(plan.warnings).toEqual(["stdin: not sent, empty value: EMPTY"]);
});

test("bad input is refused by name, never by value", () => {
  expect(() => parseBulkSecrets(`{ "lower": "s3cret-value" }`, "f.json")).toThrow("not valid: lower");
  expect(() => parseBulkSecrets(`{ "A_B": 5 }`, "f.json")).toThrow("A_B must be a non-empty string");
  expect(() => parseBulkSecrets(`{ "A_B": "" }`, "f.json")).toThrow("A_B must be a non-empty string");
  expect(() => parseBulkSecrets(`{ nope`, "f.json")).toThrow("not valid JSON");
  expect(() => parseBulkSecrets(`   `, "f")).toThrow("no secrets to set or delete");
  expect(() => parseBulkSecrets(`lower_name=x`, "f.env")).toThrow("not valid: lower_name");
  try {
    parseBulkSecrets(`{ "lower": "s3cret-value" }`, "f.json");
  } catch (error) {
    expect(String(error)).not.toContain("s3cret-value");
  }
});

test("at most 100 entries", () => {
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, "v"]));
  expect(() => parseBulkSecrets(JSON.stringify(many), "f.json")).toThrow("at most 100");
  const ok = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`K${i}`, "v"]));
  expect(Object.keys(parseBulkSecrets(JSON.stringify(ok), "f.json").set)).toHaveLength(100);
});
