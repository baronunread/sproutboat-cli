-- A KV/R2/queue resource store, dumped from the broker that shipped in v0.1.0.
-- #74 made a storage resource outlive every redeploy, so this file shape is a
-- forever-contract: a later broker must still read rows written by this one.
-- Regenerate ONLY to add to it — never to make a failing test pass, because
-- that is exactly the moment real data stopped being readable.
CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key));
INSERT INTO kv (ns, key, value) VALUES ('kv_0123456789abcdef01234567', 'greeting', 'hello from v0.1.0');
INSERT INTO kv (ns, key, value) VALUES ('kv_0123456789abcdef01234567', 'count', '41');
CREATE TABLE mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0);
CREATE TABLE r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (bucket, key));
