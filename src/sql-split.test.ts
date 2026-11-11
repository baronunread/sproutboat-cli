import { expect, test } from "bun:test";
import { splitSql } from "./sql-split";

test("splits at semicolons and drops empty statements", () => {
  expect(splitSql("SELECT 1; SELECT 2;;\n ; SELECT 3")).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  expect(splitSql("")).toEqual([]);
  expect(splitSql("  -- only a comment\n")).toEqual([]);
});

test("semicolons inside strings, identifiers and comments do not split", () => {
  expect(splitSql("INSERT INTO t VALUES ('a;b', 'it''s; ok'); SELECT \"x;y\" FROM `a;b`, [c;d]")).toEqual([
    "INSERT INTO t VALUES ('a;b', 'it''s; ok')",
    'SELECT "x;y" FROM `a;b`, [c;d]',
  ]);
  expect(splitSql("SELECT 1 -- ; not a split\n; SELECT /* ; */ 2")).toEqual([
    "SELECT 1 -- ; not a split",
    "SELECT /* ; */ 2",
  ]);
});

test("a trigger body stays one statement, CASE inside it included", () => {
  const trigger = `CREATE TRIGGER bump AFTER INSERT ON t BEGIN
  UPDATE t SET n = CASE WHEN new.n > 1 THEN 1 ELSE 0 END WHERE id = new.id;
  INSERT INTO log VALUES (new.id);
END`;
  expect(splitSql(`CREATE TABLE t (id, n); ${trigger}; SELECT 1`)).toEqual([
    "CREATE TABLE t (id, n)",
    trigger,
    "SELECT 1",
  ]);
});

test("BEGIN TRANSACTION is not a trigger body", () => {
  expect(splitSql("BEGIN TRANSACTION; INSERT INTO t VALUES (1); COMMIT;")).toEqual([
    "BEGIN TRANSACTION",
    "INSERT INTO t VALUES (1)",
    "COMMIT",
  ]);
});
