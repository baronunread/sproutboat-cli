-- Migration number: 0001
-- Apply with `sproutboat d1 migrations apply DB --local` (dev) or `--remote` (a deployed app). Applied files are
-- recorded in the d1_migrations table, so each one runs once. Add the next change as 0002_<name>.sql, never edit this.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX tasks_done_id ON tasks (done, id);
