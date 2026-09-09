/**
 * Repeatable SQLite-only measurement for the queue and alarm poll indexes.
 *
 * It intentionally measures the query shapes, not HTTP delivery. Run with:
 *
 *   bun bench/trigger-poll.ts
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = 1_800_000_000_000;
const repetitions = 250;
type Result = { plan: string; averageMs: number; writeMs: number; bytes: number };

function schema(db: Database, indexed: boolean): void {
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF");
  db.exec(
    "CREATE TABLE mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0); " +
      "CREATE TABLE do_alarm (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cls, id))",
  );
  if (indexed)
    db.exec("CREATE INDEX mq_due ON mq (queue, dead, visible_at); CREATE INDEX do_alarm_due ON do_alarm (at)");
}

function fixture(db: Database): void {
  const queue = db.query(
    "INSERT INTO mq (queue, id, body, visible_at, attempts, dead) VALUES (?1, ?2, 'x', ?3, 0, ?4)",
  );
  const alarm = db.query("INSERT INTO do_alarm (cls, id, at, attempts) VALUES ('Counter', ?1, ?2, 0)");
  const insert = db.transaction(() => {
    for (const name of ["LARGE", "DELAYED", "DEAD"]) {
      for (let i = 0; i < 20_000; i++) {
        const delayed = name === "DELAYED" && i < 19_000;
        const dead = name === "DEAD" && i < 19_000;
        queue.run(name, `${name}-${i}`, delayed ? now + 60_000 : now - (i % 100), dead ? 1 : 0);
      }
    }
    for (let i = 0; i < 50_000; i++) alarm.run(`alarm-${i}`, i < 45_000 ? now + 60_000 : now - (i % 100));
  });
  insert();
}

function measure(db: Database, sql: string, params: (string | number)[]) {
  const read = db.query(sql);
  const start = performance.now();
  for (let i = 0; i < repetitions; i++) read.all(...params);
  const averageMs = (performance.now() - start) / repetitions;
  const plan = db
    .query(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => String(row.detail))
    .join(" | ");
  return { plan, averageMs };
}

function run(indexed: boolean): Record<string, Result> {
  const root = mkdtempSync(join(tmpdir(), "sb-trigger-bench-"));
  const path = join(root, "store.sqlite");
  const db = new Database(path, { create: true });
  schema(db, indexed);
  fixture(db);
  const queries: Array<[string, string, (string | number)[]]> = [
    [
      "empty queue",
      "SELECT id, body, attempts FROM mq WHERE queue = ? AND dead = 0 AND visible_at <= ? ORDER BY visible_at LIMIT 10",
      ["EMPTY", now],
    ],
    [
      "large queue",
      "SELECT id, body, attempts FROM mq WHERE queue = ? AND dead = 0 AND visible_at <= ? ORDER BY visible_at LIMIT 10",
      ["LARGE", now],
    ],
    [
      "mostly delayed queue",
      "SELECT id, body, attempts FROM mq WHERE queue = ? AND dead = 0 AND visible_at <= ? ORDER BY visible_at LIMIT 10",
      ["DELAYED", now],
    ],
    [
      "mostly dead queue",
      "SELECT id, body, attempts FROM mq WHERE queue = ? AND dead = 0 AND visible_at <= ? ORDER BY visible_at LIMIT 10",
      ["DEAD", now],
    ],
    ["large alarm set", "SELECT cls, id, at, attempts FROM do_alarm WHERE at <= ? ORDER BY at LIMIT 10", [now]],
  ];
  const results = Object.fromEntries(
    queries.map(([name, sql, params]) => [name, { ...measure(db, sql, params), writeMs: 0, bytes: 0 }]),
  );
  const write = db.query(
    "INSERT INTO mq (queue, id, body, visible_at, attempts, dead) VALUES ('WRITE', ?1, 'x', ?2, 0, 0)",
  );
  const started = performance.now();
  const transaction = db.transaction(() => {
    for (let i = 0; i < 5_000; i++) write.run(`write-${i}`, now);
  });
  transaction();
  const writeMs = performance.now() - started;
  db.close();
  const bytes = statSync(path).size;
  rmSync(root, { recursive: true, force: true });
  for (const result of Object.values(results)) {
    result.writeMs = writeMs;
    result.bytes = bytes;
  }
  return results;
}

console.log(
  JSON.stringify(
    { rows: { queues: 60_000, alarms: 50_000 }, repetitions, withoutIndex: run(false), withIndex: run(true) },
    null,
    2,
  ),
);
