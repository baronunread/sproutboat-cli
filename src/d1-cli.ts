/**
 * `sproutboat d1 execute` and `d1 migrations create|list|apply`, with Wrangler's semantics: the target is the local
 * database `dev` uses unless --remote is given, a migration is a numbered .sql file in `migrations/` (or `migrations_dir`),
 * and applied ones are recorded in a `d1_migrations` table, each migration and its tracking row in one transaction.
 *
 * Both targets run the same `Runner`: the local one drives bun:sqlite on the dev database file, the remote one posts
 * to the Cloud's `POST /v1/apps/<app>/d1/<BINDING>/query` (docs/host-data.md in the cloud repo).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SproutboatConfig } from "./config";
import { CloudError } from "./cloud";
import { isBoolean, isSafeInteger, isString, jsonObject, type JsonObject, type JsonValue } from "./json";
import { dataErrorMessage } from "./data-errors";
import { splitSql } from "./sql-split";
import { bold, dim, ok, rose } from "./style";

export type Statement = { sql: string; params?: (string | number | boolean | null)[] };
export type StatementResult = { results: JsonObject[]; success: boolean; meta: JsonObject };

/** Runs statements in one transaction: all of them take effect, or none. A `sql` may be a whole script. */
export type Runner = { label: string; run(statements: Statement[]): Promise<StatementResult[]> };

/** A statement the database refused; `statement` is the index of the entry that failed. */
export class D1QueryError extends CloudError {
  constructor(
    message: string,
    readonly statement?: number,
  ) {
    super(message);
  }
}

export const D1_SQL_MAX_BYTES = 4 * 1024 * 1024;
export const MIGRATIONS_TABLE = "d1_migrations";
export const DEFAULT_MIGRATIONS_DIR = "migrations";
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

// ---------------------------------------------------------------- arguments

export type D1Flags = {
  command?: string;
  file?: string;
  json: boolean;
  local: boolean;
  remote: boolean;
  persistTo?: string;
  yes: boolean;
  account?: string;
};

export class D1UsageError extends Error {
  constructor(
    message: string,
    readonly usage: string,
  ) {
    super(message);
  }
}

/** Split the arguments after `d1 <sub>` into positionals and flags (`--flag value` and `--flag=value`). */
export function parseD1Flags(args: readonly string[], usage: string) {
  const flags: D1Flags = { json: false, local: false, remote: false, yes: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined;
    const noValue = () => {
      if (inline !== undefined) throw new D1UsageError(`${name} takes no value`, usage);
    };
    const value = () => {
      const next = inline ?? args[(index += 1)];
      if (next === undefined || (inline === undefined && next.startsWith("--")))
        throw new D1UsageError(`${name} needs a value`, usage);
      return next;
    };
    switch (name) {
      case "--json":
        noValue();
        flags.json = true;
        break;
      case "--local":
        noValue();
        flags.local = true;
        break;
      case "--remote":
        noValue();
        flags.remote = true;
        break;
      case "--yes":
      case "-y":
        noValue();
        flags.yes = true;
        break;
      case "--command":
        flags.command = value();
        break;
      case "--file":
        flags.file = value();
        break;
      case "--persist-to":
        flags.persistTo = value();
        break;
      case "--account":
        flags.account = value();
        break;
      default:
        if (arg.startsWith("-")) throw new D1UsageError(`unknown option ${name}`, usage);
        positional.push(arg);
    }
  }
  if (flags.local && flags.remote) throw new D1UsageError("pass --local or --remote, not both", usage);
  if (flags.persistTo !== undefined && flags.remote)
    throw new D1UsageError("--persist-to is for the local database; drop --remote", usage);
  return { positional, flags };
}

// ---------------------------------------------------------------- the project's databases

export type D1Binding = { binding: string; resourceId?: string };

/** The D1 bindings of sproutboat.jsonc: a bare "DB" or { binding, id }. */
export function d1Bindings(config: SproutboatConfig): D1Binding[] {
  return (config.d1_databases ?? []).map((entry) =>
    isString(entry) ? { binding: entry } : { binding: entry.binding, resourceId: entry.id },
  );
}

/** `<database>` is the binding name; a project without that binding says which it has. */
export function pickBinding(config: SproutboatConfig, database: string): D1Binding {
  const all = d1Bindings(config);
  const found = all.find((entry) => entry.binding === database);
  if (found) return found;
  throw new CloudError(
    all.length === 0
      ? `sproutboat.jsonc has no d1_databases, so there is no database "${database}" (add "d1_databases": ["${database}"])`
      : `no D1 binding "${database}" in sproutboat.jsonc (it has: ${all.map((entry) => entry.binding).join(", ")})`,
  );
}

/** Where `dev` keeps a binding's database: `<state>/d1/<BINDING>.sqlite`, or `<state>/resources/<id>.sqlite` for a pinned one. */
export function localDatabasePath(projectDir: string, binding: D1Binding, persistTo?: string): string {
  const state = resolve(projectDir, persistTo ?? ".sproutboat/dev");
  return binding.resourceId
    ? resolve(state, "resources", `${binding.resourceId}.sqlite`)
    : resolve(state, "d1", `${binding.binding}.sqlite`);
}

// ---------------------------------------------------------------- runners

/** The dev database file, through bun:sqlite. Created when absent, as Wrangler's local mode does. */
export function localRunner(path: string): Runner {
  return {
    label: `local database ${path}`,
    async run(statements) {
      const { Database } = await import("bun:sqlite");
      mkdirSync(resolve(path, ".."), { recursive: true });
      const db = new Database(path, { create: true });
      const results: StatementResult[] = [];
      let index = 0;
      try {
        db.run("PRAGMA busy_timeout = 5000");
        db.run("BEGIN IMMEDIATE");
        for (const [at, entry] of statements.entries()) {
          index = at;
          const parts = entry.params === undefined ? splitSql(entry.sql) : [entry.sql];
          for (const sql of parts) {
            const started = performance.now();
            const query = db.query(sql);
            const bound = (entry.params ?? []).map((param) => (isBoolean(param) ? Number(param) : param));
            // SAFETY: bun:sqlite returns each row as a plain object keyed by column name, holding SQLite values (numbers, strings, null).
            const rows = query.columnNames.length > 0 ? (query.all(...bound) as JsonObject[]) : [];
            const info = query.columnNames.length > 0 ? { changes: 0, lastInsertRowid: 0 } : query.run(...bound);
            results.push({
              results: rows,
              success: true,
              meta: {
                duration: Math.round((performance.now() - started) * 100) / 100,
                changes: info.changes,
                last_row_id: Number(info.lastInsertRowid),
                rows_read: rows.length,
                rows_written: info.changes,
                changed_db: info.changes > 0,
              },
            });
          }
        }
        db.run("COMMIT");
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // no transaction left to roll back
        }
        throw new D1QueryError(error instanceof Error ? error.message : String(error), index);
      } finally {
        db.close();
      }
      return results;
    },
  };
}

export type Reply = { status: number; body?: JsonObject; headers?: Headers };

/**
 * A remote database through `send`, which posts the request body and returns the status and JSON. `endpoint` names it in
 * messages. A Community control plane has no such route: its 404 becomes "not supported on self-hosted Community yet".
 */
export function remoteRunner(options: {
  label: string;
  project: string;
  binding: string;
  community: boolean;
  send: (body: { statements: Statement[]; transaction: true }) => Promise<Reply>;
}): Runner {
  const { project, binding } = options;
  return {
    label: options.label,
    async run(statements) {
      const reply = await options.send({ statements, transaction: true });
      const body = reply.body;
      const message = isString(body?.error) ? body.error : `HTTP ${reply.status}`;
      if (reply.status === 404) {
        if (options.community)
          throw new CloudError(
            "remote D1 queries are not supported on self-hosted Community yet (this endpoint has no D1 route); use --local, or a Sproutboat Cloud endpoint",
          );
        if (body?.reason === "no-database")
          throw new CloudError(
            `${project} has no D1 database "${binding}" on its host yet; a database exists once the deployed app has used it`,
          );
        throw new CloudError(
          `${project} is not deployed yet, so it has no database: run \`sproutboat deploy\` first, or use --local`,
        );
      }
      if (reply.status === 400 && body?.reason === "sql-error")
        throw new D1QueryError(message, isSafeInteger(body.statement) ? body.statement : undefined);
      if (reply.status !== 200) {
        const explained = dataErrorMessage(reply, {
          project,
          product: "D1",
          noun: "database",
          name: binding,
          write: true,
        });
        throw new CloudError(explained ?? message);
      }
      const list = Array.isArray(body?.results) ? body.results : [];
      return list.map((entry) => {
        const item = jsonObject(entry);
        return {
          results: Array.isArray(item?.results)
            ? item.results.flatMap((row) => {
                const parsed = jsonObject(row);
                return parsed ? [parsed] : [];
              })
            : [],
          success: item?.success !== false,
          meta: jsonObject(item?.meta ?? null) ?? {},
        };
      });
    },
  };
}

// ---------------------------------------------------------------- output

export type D1Io = {
  log(line: string): void;
  /** Progress and notices; stderr when stdout carries JSON. */
  note(line: string): void;
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
};

/** A plain table: header, rule, rows. Objects print their JSON; null prints as NULL. */
export function formatTable(rows: JsonObject[]): string {
  if (rows.length === 0) return dim("(no rows)");
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: JsonValue | undefined) =>
    value === null || value === undefined ? "NULL" : isString(value) ? value : JSON.stringify(value);
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => cell(row[column]).length)));
  const line = (values: string[]) =>
    values
      .map((value, at) => value.padEnd(widths[at]!))
      .join("  ")
      .trimEnd();
  return [
    bold(line(columns)),
    dim(widths.map((width) => "─".repeat(width)).join("  ")),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join("\n");
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- d1 execute

export const EXECUTE_USAGE =
  "d1 execute <database> (--command <sql> | --file <path>) [--json] [--local | --remote] [--persist-to <dir>] [--yes]";

export type ExecuteInput = { flags: D1Flags; runner: Runner; remote: boolean; io: D1Io; cwd: string };

export async function executeSql(input: ExecuteInput): Promise<StatementResult[]> {
  const { flags, runner, io, remote } = input;
  if ((flags.command === undefined) === (flags.file === undefined))
    throw new D1UsageError("you must provide either --command or --file", EXECUTE_USAGE);
  let sql = flags.command ?? "";
  if (flags.file !== undefined) {
    const path = resolve(input.cwd, flags.file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new CloudError(`${flags.file}: no such file`);
    sql = readFileSync(path, "utf8");
  }
  if (splitSql(sql).length === 0)
    throw new CloudError(flags.file !== undefined ? `${flags.file} holds no SQL` : "--command holds no SQL");
  if (remote && Buffer.byteLength(sql) > D1_SQL_MAX_BYTES)
    throw new CloudError(
      `the SQL is ${(Buffer.byteLength(sql) / 1048576).toFixed(1)} MiB; a remote request may carry at most 4 MiB, so split the file`,
    );
  if (remote && flags.file !== undefined && io.interactive && !flags.yes) {
    if (!(await io.confirm(`About to run ${flags.file} on ${runner.label} as one transaction. Ok to proceed?`)))
      throw new CloudError("cancelled");
  }
  const asJson = flags.json || !io.interactive;
  io.note(`${dim("🌀")} Executing on ${runner.label}${remote ? "" : dim(" (pass --remote for the deployed app)")}`);
  const started = performance.now();
  const results = await runner.run([{ sql }]);
  const elapsed = Math.round(performance.now() - started);
  io.note(ok(`${plural(results.length, "command")} executed successfully in ${elapsed} ms`));
  if (asJson) {
    io.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) if (result.results.length > 0) io.log(formatTable(result.results));
  }
  return results;
}

// ---------------------------------------------------------------- migrations

export function migrationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

/** The next number: one past the highest `NNNN_` prefix in the folder, four digits (Wrangler starts at 0001). */
export function nextMigrationNumber(dir: string): string {
  const highest = migrationFiles(dir).reduce((max, name) => {
    const match = /^(\d+)_/.exec(name);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return String(highest + 1).padStart(4, "0");
}

export const CREATE_USAGE = "d1 migrations create <database> <name>";
export const LIST_USAGE = "d1 migrations list <database> [--local | --remote] [--persist-to <dir>]";
export const APPLY_USAGE = "d1 migrations apply <database> [--local | --remote] [--persist-to <dir>]";

/** Create `NNNN_<name>.sql` in the migrations folder, asking before creating the folder itself. */
export async function createMigration(dir: string, message: string, io: D1Io, now = new Date()): Promise<string> {
  if (message.trim() === "") throw new D1UsageError("the migration needs a name", CREATE_USAGE);
  if (!existsSync(dir)) {
    if (io.interactive && !(await io.confirm(`No migrations folder found. Ok to create ${dir}?`)))
      throw new CloudError("cancelled");
    mkdirSync(dir, { recursive: true });
  }
  const number = nextMigrationNumber(dir);
  const name = `${number}_${message.trim().replace(/\s+/g, "_")}.sql`;
  const path = resolve(dir, name);
  if (existsSync(path)) throw new CloudError(`${name} already exists`);
  writeFileSync(path, `-- Migration number: ${number} \t ${now.toISOString()}\n`);
  io.log(ok(`Created migration ${bold(name)}`));
  io.log(`${dim("edit it here:")} ${path}`);
  return name;
}

/** The names recorded in d1_migrations, in order; none when the table does not exist yet (nothing was ever applied). */
export async function appliedMigrations(runner: Runner): Promise<string[]> {
  try {
    const [result] = await runner.run([{ sql: `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id` }]);
    return (result?.results ?? []).map((row) => String(row.name));
  } catch (error) {
    if (error instanceof D1QueryError && /no such table/i.test(error.message)) return [];
    throw error;
  }
}

export async function pendingMigrations(runner: Runner, dir: string): Promise<string[]> {
  const applied = new Set(await appliedMigrations(runner));
  return migrationFiles(dir).filter((name) => !applied.has(name));
}

const nameTable = (rows: { name: string; status: string }[]) => formatTable(rows);

export async function listMigrations(runner: Runner, dir: string, io: D1Io): Promise<string[]> {
  const pending = await pendingMigrations(runner, dir);
  if (pending.length === 0) io.log(ok("No migrations to apply"));
  else {
    io.log(`Migrations to be applied:`);
    io.log(nameTable(pending.map((name) => ({ name, status: "pending" }))));
  }
  return pending;
}

/**
 * Apply the pending migrations in order. Each runs together with its tracking row in one transaction (so a failure leaves
 * the database as it was before that migration, and the earlier ones applied), and the first failure stops the run.
 */
export async function applyMigrations(runner: Runner, dir: string, io: D1Io): Promise<string[]> {
  await runner.run([{ sql: CREATE_MIGRATIONS_TABLE }]);
  const pending = await pendingMigrations(runner, dir);
  if (pending.length === 0) {
    io.log(ok("No migrations to apply"));
    return [];
  }
  io.log(`Migrations to be applied:`);
  io.log(nameTable(pending.map((name) => ({ name, status: "pending" }))));
  if (
    io.interactive &&
    !(await io.confirm(`About to apply ${plural(pending.length, "migration")} to ${runner.label}. Continue?`))
  )
    throw new CloudError("cancelled");
  const done: string[] = [];
  for (const name of pending) {
    const sql = readFileSync(resolve(dir, name), "utf8");
    if (Buffer.byteLength(sql) > D1_SQL_MAX_BYTES)
      throw new CloudError(`${name} is larger than 4 MiB; split it into smaller migrations`);
    try {
      await runner.run([
        { sql: `PRAGMA defer_foreign_keys = true;\n${sql}` },
        { sql: `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`, params: [name] },
      ]);
    } catch (error) {
      if (done.length > 0) io.log(nameTable(done.map((applied) => ({ name: applied, status: "applied" }))));
      io.log(`${rose("✗")} ${name} ${rose("failed and was rolled back")}`);
      throw error instanceof D1QueryError
        ? new CloudError(
            `${name}: ${error.message}${done.length ? `\n${plural(done.length, "earlier migration")} stay applied` : ""}`,
          )
        : error;
    }
    done.push(name);
    io.log(`${ok(name)}`);
  }
  io.log(ok(`${plural(done.length, "migration")} applied to ${runner.label}`));
  return done;
}
