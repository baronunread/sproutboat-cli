/**
 * The embedded transport: SQLite compiled into the sprout, no broker at all.
 *
 * Same contract as transport-broker.js — `__sbCall(reqJson) -> replyJson` — so
 * every binding shim above it is unchanged and the conformance suite is the
 * proof that the swap changed no behaviour.
 *
 * The split is deliberate: C does only what JS cannot (open a database, bind
 * parameters, step a statement, encode a row), and every op — which SQL, which
 * partition key, what shape comes back — stays in JS, mirroring broker.ts. That
 * keeps the second implementation of the binding ops as small as it can be,
 * which is the whole worry with having one at all.
 *
 * Paths come from __sbEnv: the launcher-free binary is told its data directory
 * through SB_DATA_DIR, the same way it learns its port.
 */

// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
#include <stdint.h>
#include <sys/stat.h>

// sqlite3 is linked in via SB_EXTRA_LINK (see patch-porffor.ts). Declared here
// rather than including sqlite3.h so the build needs no include path.
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
extern int sqlite3_open(const char*, sqlite3**);
extern int sqlite3_exec(sqlite3*, const char*, void*, void*, char**);
extern int sqlite3_prepare_v2(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
extern int sqlite3_step(sqlite3_stmt*);
extern int sqlite3_finalize(sqlite3_stmt*);
extern int sqlite3_reset(sqlite3_stmt*);
extern int sqlite3_column_count(sqlite3_stmt*);
extern int sqlite3_column_type(sqlite3_stmt*, int);
extern const unsigned char* sqlite3_column_text(sqlite3_stmt*, int);
extern int sqlite3_column_bytes(sqlite3_stmt*, int);
extern double sqlite3_column_double(sqlite3_stmt*, int);
extern const char* sqlite3_column_name(sqlite3_stmt*, int);
extern int sqlite3_bind_null(sqlite3_stmt*, int);
extern int sqlite3_bind_double(sqlite3_stmt*, int, double);
extern int sqlite3_bind_text(sqlite3_stmt*, int, const char*, int, void*);
extern int sqlite3_changes(sqlite3*);
extern int64_t sqlite3_last_insert_rowid(sqlite3*);
extern const char* sqlite3_errmsg(sqlite3*);

#define SB_SQLITE_ROW 100
#define SB_SQLITE_DONE 101
#define SB_SQLITE_TRANSIENT ((void*)-1)
#define SB_MAX_DB 16

static sqlite3* sb_dbs[SB_MAX_DB];
static char sb_db_names[SB_MAX_DB][256];
static int sb_db_count = 0;

// One handle per path, opened once and kept for the process lifetime — the same
// lifetime the broker gives a Database. Returns an index, or -1.
// Create every parent directory of path, like mkdir -p. A standalone binary
// has no launcher to prepare its data directory, and sqlite3_open creates files
// but never the directories above them.
static void sb_mkdirs(const char* path) {
  char tmp[1024];
  size_t n = strlen(path);
  if (n == 0 || n >= sizeof(tmp)) return;
  memcpy(tmp, path, n + 1);
  for (char* p = tmp + 1; *p; p++) {
    if (*p != '/') continue;
    *p = 0;
    mkdir(tmp, 0700);
    *p = '/';
  }
}

static int sb_db_for(const char* path) {
  for (int i = 0; i < sb_db_count; i++) {
    if (strcmp(sb_db_names[i], path) == 0) return i;
  }
  if (sb_db_count >= SB_MAX_DB) return -1;
  sqlite3* db = 0;
  sb_mkdirs(path);
  if (sqlite3_open(path, &db) != 0) return -1;
  sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;", 0, 0, 0);
  sb_dbs[sb_db_count] = db;
  snprintf(sb_db_names[sb_db_count], 256, "%s", path);
  return sb_db_count++;
}

// --- a growable output buffer, for building the reply JSON ------------------
typedef struct { char* p; size_t len; size_t cap; } sb_buf;
static void sb_buf_need(sb_buf* b, size_t extra) {
  if (b->len + extra + 1 <= b->cap) return;
  size_t cap = b->cap ? b->cap * 2 : 1024;
  while (cap < b->len + extra + 1) cap *= 2;
  b->p = (char*)realloc(b->p, cap);
  b->cap = cap;
}
static void sb_put(sb_buf* b, const char* s, size_t n) {
  sb_buf_need(b, n);
  memcpy(b->p + b->len, s, n);
  b->len += n;
  b->p[b->len] = 0;
}
static void sb_puts(sb_buf* b, const char* s) { sb_put(b, s, strlen(s)); }
static void sb_putjson(sb_buf* b, const char* s, size_t n) {
  sb_put(b, "\"", 1);
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { char e[2] = { '\\', (char)c }; sb_put(b, e, 2); }
    else if (c == '\n') sb_put(b, "\\n", 2);
    else if (c == '\r') sb_put(b, "\\r", 2);
    else if (c == '\t') sb_put(b, "\\t", 2);
    else if (c < 0x20) { char e[8]; int k = snprintf(e, 8, "\\u%04x", c); sb_put(b, e, (size_t)k); }
    else sb_put(b, (const char*)&c, 1);
  }
  sb_put(b, "\"", 1);
}

// --- the narrow JSON reader: a flat array of null | number | string ----------
// Only ever fed __sbSql's own params, which JS builds; anything unexpected
// binds as NULL rather than guessing.
static const char* sb_skip_ws(const char* p) { while (*p == ' ' || *p == '\n' || *p == '\t' || *p == '\r') p++; return p; }

static int sb_bind_params(sqlite3_stmt* st, const char* json) {
  const char* p = sb_skip_ws(json);
  if (*p != '[') return 0;
  p++;
  int index = 1;
  while (1) {
    p = sb_skip_ws(p);
    if (*p == ']' || *p == 0) break;
    if (*p == ',') { p++; continue; }
    if (*p == 'n') { sqlite3_bind_null(st, index++); p += 4; continue; }
    if (*p == '"') {
      p++;
      char* out = (char*)malloc(strlen(p) + 1);
      size_t n = 0;
      while (*p && *p != '"') {
        if (*p == '\\' && p[1]) {
          p++;
          char c = *p++;
          if (c == 'n') out[n++] = '\n';
          else if (c == 't') out[n++] = '\t';
          else if (c == 'r') out[n++] = '\r';
          else if (c == 'u') {
            unsigned int cp = 0;
            for (int k = 0; k < 4 && *p; k++) {
              char h = *p++;
              cp = cp * 16 + (unsigned int)(h >= 'a' ? h - 'a' + 10 : (h >= 'A' ? h - 'A' + 10 : h - '0'));
            }
            // Encode as UTF-8; surrogate halves are passed through as-is.
            if (cp < 0x80) out[n++] = (char)cp;
            else if (cp < 0x800) { out[n++] = (char)(0xC0 | (cp >> 6)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
            else { out[n++] = (char)(0xE0 | (cp >> 12)); out[n++] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
          } else out[n++] = c;
        } else out[n++] = *p++;
      }
      if (*p == '"') p++;
      sqlite3_bind_text(st, index++, out, (int)n, SB_SQLITE_TRANSIENT);
      free(out);
      continue;
    }
    // number (or true/false, bound as 1/0)
    if (*p == 't') { sqlite3_bind_double(st, index++, 1); p += 4; continue; }
    if (*p == 'f') { sqlite3_bind_double(st, index++, 0); p += 5; continue; }
    {
      char* endp = 0;
      double v = strtod(p, &endp);
      if (endp == p) break; // not something we understand; stop rather than spin
      sqlite3_bind_double(st, index++, v);
      p = endp;
    }
  }
  return 0;
}

// Run one statement. Returns malloc'd JSON:
//   {"ok":true,"cols":[...],"rows":[[...]],"changes":n,"rowid":n}
// or {"ok":false,"error":"..."}.
static char* sb_sql_run(const char* path, const char* sql, const char* params) {
  sb_buf b = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0) { sb_puts(&b, "{\"ok\":false,\"error\":\"cannot open database\"}"); return b.p; }
  sqlite3* db = sb_dbs[idx];
  sqlite3_stmt* st = 0;
  if (sqlite3_prepare_v2(db, sql, -1, &st, 0) != 0 || !st) {
    sb_puts(&b, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson(&b, m, strlen(m));
    sb_puts(&b, "}");
    return b.p;
  }
  if (params && *params) sb_bind_params(st, params);

  sb_puts(&b, "{\"ok\":true,\"cols\":[");
  int ncol = sqlite3_column_count(st);
  for (int i = 0; i < ncol; i++) {
    if (i) sb_puts(&b, ",");
    const char* name = sqlite3_column_name(st, i);
    sb_putjson(&b, name ? name : "", name ? strlen(name) : 0);
  }
  sb_puts(&b, "],\"rows\":[");
  int rc, first = 1;
  while ((rc = sqlite3_step(st)) == SB_SQLITE_ROW) {
    if (!first) sb_puts(&b, ",");
    first = 0;
    sb_puts(&b, "[");
    for (int i = 0; i < ncol; i++) {
      if (i) sb_puts(&b, ",");
      int t = sqlite3_column_type(st, i);
      if (t == 5) { sb_puts(&b, "null"); continue; }             // SQLITE_NULL
      if (t == 1 || t == 2) {                                     // INTEGER / FLOAT
        char num[40];
        int k = snprintf(num, 40, "%.17g", sqlite3_column_double(st, i));
        sb_put(&b, num, (size_t)k);
        continue;
      }
      const unsigned char* txt = sqlite3_column_text(st, i);
      int n = sqlite3_column_bytes(st, i);
      sb_putjson(&b, txt ? (const char*)txt : "", txt ? (size_t)n : 0);
    }
    sb_puts(&b, "]");
  }
  char tail[96];
  int k = snprintf(tail, 96, "],\"changes\":%d,\"rowid\":%lld}", sqlite3_changes(db), (long long)sqlite3_last_insert_rowid(db));
  sb_put(&b, tail, (size_t)k);
  sqlite3_finalize(st);
  if (rc != SB_SQLITE_DONE && rc != SB_SQLITE_ROW) {
    free(b.p);
    sb_buf e = { 0, 0, 0 };
    sb_puts(&e, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson(&e, m, strlen(m));
    sb_puts(&e, "}");
    return e.p;
  }
  return b.p;
}
`;

// One statement in, one JSON reply out. `path`, `sql` and `paramsJson` are
// parameters so the generated C names them directly.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbSqlRaw(path, sql, paramsJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(sql, &__s, &__sl, &__so);
    char* __sql = (char*)malloc(__sl + 1); memcpy(__sql, __s, __sl); __sql[__sl] = 0;
    if (__so) free(__so);

    const char* __a; size_t __al; char* __ao = 0;
    porf_native_fetch_read_value(paramsJson, &__a, &__al, &__ao);
    char* __args = (char*)malloc(__al + 1); memcpy(__args, __a, __al); __args[__al] = 0;
    if (__ao) free(__ao);

    char* __out = sb_sql_run(__path, __sql, __args);
    free(__path); free(__sql); free(__args);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    } else {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring("{\"ok\":false,\"error\":\"no result\"}", 38), 195);
    }
  `;
  return res;
}

// --- the op dispatch, in JS -------------------------------------------------
// Deliberately the same SQL and the same partition keys as broker.ts. When one
// changes the other has to, and the conformance suite is what says so.

var __sbDataDir = "";
function __sbDir() {
  // SB_DATA_DIR, else `<name>.data` relative to the working directory — the
  // same rule the phase-0 launcher applies, baked in because there is no
  // launcher here to apply it.
  if (!__sbDataDir) __sbDataDir = __sbEnv("SB_DATA_DIR") || (globalThis.__sbAppName || "app") + ".data";
  return __sbDataDir;
}
function __sbStore() {
  return __sbDir() + "/store.sqlite";
}
function __sbD1Path(name) {
  return __sbDir() + "/d1/" + name + ".sqlite";
}

function __sbSql(path, sql, params) {
  const reply = JSON.parse(__sbSqlRaw(path, sql, params == null ? "[]" : JSON.stringify(params)));
  if (reply.ok === false) throw new Error("sqlite: " + reply.error);
  return reply;
}

var __sbSchemaReady = false;
function __sbEnsureSchema() {
  if (__sbSchemaReady) return;
  __sbSchemaReady = true;
  const s = __sbStore();
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, " +
      "etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', " +
      "PRIMARY KEY (bucket, key))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, " +
      "visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0)",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS do_storage (cls TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (cls, id, key))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS do_alarm (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cls, id))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS ae (dataset TEXT NOT NULL, ts INTEGER NOT NULL, indexes_json TEXT NOT NULL, blobs_json TEXT NOT NULL, doubles_json TEXT NOT NULL)",
  );
}

function __sbHex(n) {
  let out = "";
  const bytes = __sbRandomBytes(String(n));
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes.charCodeAt(i).toString(16);
    out += h.length === 1 ? "0" + h : h;
  }
  return out;
}

function __sbEmbeddedDispatch(msg) {
  __sbEnsureSchema();
  const store = __sbStore();
  const op = msg.op;

  if (op === "ping") return { ok: true, op: "pong", echo: msg.msg };

  if (op === "kv.get") {
    const r = __sbSql(store, "SELECT value FROM kv WHERE ns = ? AND key = ?", [msg.ns, msg.key]);
    return r.rows.length ? { ok: true, found: true, value: r.rows[0][0] } : { ok: true, found: false, value: null };
  }
  if (op === "kv.put") {
    __sbSql(store, "INSERT INTO kv (ns, key, value) VALUES (?1,?2,?3) ON CONFLICT (ns, key) DO UPDATE SET value = ?3", [
      msg.ns,
      msg.key,
      msg.value,
    ]);
    return { ok: true };
  }
  if (op === "kv.delete") {
    __sbSql(store, "DELETE FROM kv WHERE ns = ? AND key = ?", [msg.ns, msg.key]);
    return { ok: true };
  }
  if (op === "kv.list") {
    const r = __sbSql(store, "SELECT key FROM kv WHERE ns = ? AND key LIKE ? || '%' ORDER BY key", [
      msg.ns,
      msg.prefix || "",
    ]);
    const keys = [];
    for (let i = 0; i < r.rows.length; i++) keys.push(r.rows[i][0]);
    return { ok: true, keys };
  }

  if (op === "secret.get") {
    // Secrets reach a standalone binary through the environment, the same
    // channel the launcher and the supervisor use; there is nothing to decrypt.
    const value = __sbEnv(String(msg.name));
    if (!value) throw new Error("secret not set: " + msg.name);
    return { ok: true, value };
  }

  if (op === "d1.query" || op === "d1.exec" || op === "d1.batch") {
    const path = __sbD1Path(String(msg.db));
    if (op === "d1.exec") {
      __sbSql(path, String(msg.sql), []);
      return { ok: true };
    }
    if (op === "d1.batch") {
      const results = [];
      const list = msg.statements || [];
      for (let i = 0; i < list.length; i++) results.push(__sbD1Run(path, list[i].sql, list[i].params));
      return { ok: true, results };
    }
    const one = __sbD1Run(path, msg.sql, msg.params);
    return { ok: true, results: one.results, meta: one.meta, success: true };
  }

  if (op === "r2.put") {
    const body = String(msg.body == null ? "" : msg.body);
    const etag = __sbHex(16);
    __sbSql(
      store,
      "INSERT INTO r2 (bucket, key, body, size, etag, uploaded, http_json, custom_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) " +
        "ON CONFLICT (bucket, key) DO UPDATE SET body=?3, size=?4, etag=?5, uploaded=?6, http_json=?7, custom_json=?8",
      [
        msg.bucket,
        msg.key,
        body,
        body.length,
        etag,
        new Date().toISOString(),
        JSON.stringify(msg.httpMetadata || {}),
        JSON.stringify(msg.customMetadata || {}),
      ],
    );
    return { ok: true, etag, size: body.length };
  }
  if (op === "r2.get" || op === "r2.head") {
    const r = __sbSql(
      store,
      "SELECT body, size, etag, uploaded, http_json, custom_json FROM r2 WHERE bucket = ? AND key = ?",
      [msg.bucket, msg.key],
    );
    if (!r.rows.length) return { ok: true, found: false };
    const row = r.rows[0];
    return {
      ok: true,
      found: true,
      body: op === "r2.get" ? row[0] : undefined,
      size: Number(row[1]),
      etag: row[2],
      uploaded: row[3],
      httpMetadata: JSON.parse(row[4] || "{}"),
      customMetadata: JSON.parse(row[5] || "{}"),
    };
  }
  if (op === "r2.delete") {
    __sbSql(store, "DELETE FROM r2 WHERE bucket = ? AND key = ?", [msg.bucket, msg.key]);
    return { ok: true };
  }
  if (op === "r2.list") {
    const r = __sbSql(
      store,
      "SELECT key, size, etag, uploaded FROM r2 WHERE bucket = ? AND key LIKE ? || '%' ORDER BY key",
      [msg.bucket, msg.prefix || ""],
    );
    const objects = [];
    for (let i = 0; i < r.rows.length; i++) {
      objects.push({ key: r.rows[i][0], size: Number(r.rows[i][1]), etag: r.rows[i][2], uploaded: r.rows[i][3] });
    }
    return { ok: true, objects };
  }

  if (op === "queue.send" || op === "queue.send_batch") {
    const items = op === "queue.send" ? [msg.body] : msg.messages || [];
    for (let i = 0; i < items.length; i++) {
      __sbSql(store, "INSERT INTO mq (queue, id, body, visible_at, attempts, dead) VALUES (?1,?2,?3,?4,0,0)", [
        msg.queue,
        __sbHex(12),
        String(items[i]),
        Date.now(),
      ]);
    }
    return { ok: true };
  }

  if (op === "do.storage.get") {
    const r = __sbSql(store, "SELECT value FROM do_storage WHERE cls = ? AND id = ? AND key = ?", [
      msg.cls,
      msg.id,
      msg.key,
    ]);
    return r.rows.length ? { ok: true, found: true, value: r.rows[0][0] } : { ok: true, found: false };
  }
  if (op === "do.storage.put") {
    __sbSql(
      store,
      "INSERT INTO do_storage (cls, id, key, value) VALUES (?1,?2,?3,?4) ON CONFLICT (cls, id, key) DO UPDATE SET value = ?4",
      [msg.cls, msg.id, msg.key, msg.value],
    );
    return { ok: true };
  }
  if (op === "do.storage.delete") {
    const r = __sbSql(store, "DELETE FROM do_storage WHERE cls = ? AND id = ? AND key = ?", [msg.cls, msg.id, msg.key]);
    return { ok: true, deleted: r.changes > 0 };
  }
  if (op === "do.storage.delete_all") {
    __sbSql(store, "DELETE FROM do_storage WHERE cls = ? AND id = ?", [msg.cls, msg.id]);
    return { ok: true };
  }
  if (op === "do.storage.list") {
    const r = __sbSql(
      store,
      "SELECT key, value FROM do_storage WHERE cls = ? AND id = ? AND key LIKE ? || '%' ORDER BY key",
      [msg.cls, msg.id, msg.prefix || ""],
    );
    const entries = [];
    for (let i = 0; i < r.rows.length; i++) entries.push([r.rows[i][0], r.rows[i][1]]);
    return { ok: true, entries };
  }
  if (op === "do.alarm.set") {
    __sbSql(
      store,
      "INSERT INTO do_alarm (cls, id, at, attempts) VALUES (?1,?2,?3,0) ON CONFLICT (cls, id) DO UPDATE SET at = ?3, attempts = 0",
      [msg.cls, msg.id, Math.trunc(Number(msg.at) || 0)],
    );
    return { ok: true };
  }
  if (op === "do.alarm.get") {
    const r = __sbSql(store, "SELECT at FROM do_alarm WHERE cls = ? AND id = ?", [msg.cls, msg.id]);
    return { ok: true, at: r.rows.length ? Number(r.rows[0][0]) : null };
  }
  if (op === "do.alarm.delete") {
    const r = __sbSql(store, "DELETE FROM do_alarm WHERE cls = ? AND id = ?", [msg.cls, msg.id]);
    return { ok: true, deleted: r.changes > 0 };
  }

  if (op === "ae.write") {
    __sbSql(store, "INSERT INTO ae (dataset, ts, indexes_json, blobs_json, doubles_json) VALUES (?1,?2,?3,?4,?5)", [
      msg.dataset,
      Date.now(),
      JSON.stringify(msg.indexes || []),
      JSON.stringify(msg.blobs || []),
      JSON.stringify(msg.doubles || []),
    ]);
    return { ok: true };
  }
  if (op === "ae.query") {
    const r = __sbSql(
      store,
      "SELECT ts, indexes_json, blobs_json, doubles_json FROM ae WHERE dataset = ? ORDER BY ts DESC LIMIT 100",
      [msg.dataset],
    );
    const rows = [];
    for (let i = 0; i < r.rows.length; i++) {
      rows.push({
        timestamp: Number(r.rows[i][0]),
        indexes: JSON.parse(r.rows[i][1]),
        blobs: JSON.parse(r.rows[i][2]),
        doubles: JSON.parse(r.rows[i][3]),
      });
    }
    return { ok: true, rows };
  }

  throw new Error("unknown op: " + op);
}

/** One D1 statement, shaped like the broker's d1Run. */
function __sbD1Run(path, sql, params) {
  const r = __sbSql(path, String(sql), params || []);
  const results = [];
  for (let i = 0; i < r.rows.length; i++) {
    const row = {};
    for (let c = 0; c < r.cols.length; c++) row[r.cols[c]] = r.rows[i][c];
    results.push(row);
  }
  return { results, meta: { changes: r.changes, last_row_id: r.rowid, rows_read: r.rows.length } };
}

/** The transport contract: one request string in, one reply string out. */
function __sbCall(reqJson) {
  try {
    return JSON.stringify(__sbEmbeddedDispatch(JSON.parse(reqJson)));
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}
