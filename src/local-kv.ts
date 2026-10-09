import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resourceRefs, type SproutboatConfig } from "./config";
import { isBoolean, isString, jsonObject, parseJsonValue, type JsonValue } from "./json";

export type DataTarget = { local: boolean; dataDir?: string; projectDir?: string };

/** Remove target options before the contents command parses its own arguments. */
export function takeDataTarget(args: string[]): DataTarget {
  const target: DataTarget = { local: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length;) {
    const flag = args[i];
    if (!["--local", "--remote", "--data-dir", "--project-dir"].includes(flag)) {
      i++;
      continue;
    }
    if (seen.has(flag)) throw new Error(`${flag} may only be specified once`);
    seen.add(flag);
    if (flag === "--local" || flag === "--remote") {
      args.splice(i, 1);
      target.local = flag === "--local";
    } else {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
      if (flag === "--data-dir") target.dataDir = value;
      else target.projectDir = value;
      args.splice(i, 2);
    }
  }
  if (seen.has("--local") && seen.has("--remote")) throw new Error("choose --local or --remote, not both");
  if (!target.local && (target.dataDir || target.projectDir))
    throw new Error("--data-dir and --project-dir require --local");
  return target;
}

export function localKvTarget(projectDir: string, config: SproutboatConfig, binding: string, dataDir?: string) {
  const ref = resourceRefs(config.kv_namespaces).find((entry) => entry.binding === binding);
  if (!ref) throw new Error(`no KV binding named "${binding}" in ${projectDir}/sproutboat.jsonc`);
  const directory = dataDir ? resolve(dataDir) : resolve(projectDir, ".sproutboat/dev");
  const standalone = resolve(directory, "store.sqlite");
  const dev = resolve(directory, "state.sqlite");
  if (dataDir && existsSync(standalone) && existsSync(dev))
    throw new Error(`ambiguous data directory ${directory}: contains both store.sqlite and state.sqlite`);
  const isStandalone = Boolean(dataDir && existsSync(standalone));
  const path = isStandalone ? standalone : ref.id ? resolve(directory, "resources", `${ref.id}.sqlite`) : dev;
  if (!existsSync(path)) throw new Error(`local KV store not found: ${path}; start dev or the standalone app first`);
  return { path, namespace: isStandalone ? binding : (ref.id ?? binding) };
}

type KvRecord = { key: string; value: string | null; base64?: boolean; expiration?: number };

export type KvRequest = (path: string, init?: RequestInit) => Promise<Response>;

/** Open the existing runtime schema without starting a broker or migrating state. */
export function openLocalKv(path: string, namespace: string, writable: boolean) {
  const db = new Database(path, { create: false, readonly: !writable, readwrite: writable });
  try {
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(kv)")
      .all()
      .map((column) => column.name);
    if (!["ns", "key", "value"].every((name) => columns.includes(name)))
      throw new Error(`not a supported KV store: ${path}`);
    const expiry = columns.includes("expires_at") ? "expires_at" : "NULL";
    const binary = columns.includes("binary") ? "binary" : "0";
    db.exec("PRAGMA busy_timeout = 5000");
    // Keep paginated reads on one SQLite snapshot while WAL writers continue.
    if (!writable) db.exec("BEGIN");
    const readAt = Date.now();
    const get = db.query<{ value: string; binary: number; expires_at: number | null }, [string, string, number]>(
      `SELECT value, ${binary} AS binary, ${expiry} AS expires_at FROM kv WHERE ns = ? AND key = ? AND (${expiry} IS NULL OR ${expiry} > ?)`,
    );
    const read = (key: string): KvRecord => {
      const row = get.get(namespace, key, readAt);
      if (!row) return { key, value: null };
      const record: KvRecord = {
        key,
        value: row.binary ? Buffer.from(row.value, "latin1").toString("base64") : row.value,
      };
      if (row.binary) record.base64 = true;
      if (row.expires_at != null) record.expiration = row.expires_at / 1000;
      return record;
    };
    const put = (entry: JsonValue) => {
      const record = jsonObject(entry);
      if (!record || !isString(record.key) || !record.key || !isString(record.value))
        throw new Error("every entry must contain a non-empty key and string value");
      if (record.base64 !== undefined && !isBoolean(record.base64)) throw new Error("base64 must be a boolean");
      if (record.base64 && !columns.includes("binary")) throw new Error("this KV store does not support binary values");
      if (record.base64 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.value))
        throw new Error("invalid base64 value");
      const expiration = record.expiration === undefined ? undefined : Number(record.expiration);
      if (
        expiration !== undefined &&
        (record.expiration !== expiration || !Number.isFinite(expiration) || expiration <= 0)
      )
        throw new Error("expiration must be a positive Unix timestamp in seconds");
      if (expiration !== undefined && !columns.includes("expires_at"))
        throw new Error("this KV store does not support expiration");
      const value = record.base64 ? Buffer.from(record.value, "base64").toString("latin1") : record.value;
      const names = [
        "ns",
        "key",
        "value",
        ...(columns.includes("expires_at") ? ["expires_at"] : []),
        ...(columns.includes("binary") ? ["binary"] : []),
      ];
      const values = [
        namespace,
        record.key,
        value,
        ...(columns.includes("expires_at") ? [expiration === undefined ? null : expiration * 1000] : []),
        ...(columns.includes("binary") ? [record.base64 ? 1 : 0] : []),
      ];
      // Ordinary puts reset expiry; restorable dumps can preserve an absolute expiry.
      db.query(
        `INSERT INTO kv (${names.join(",")}) VALUES (${names.map(() => "?").join(",")}) ON CONFLICT(ns,key) DO UPDATE SET ${names
          .slice(2)
          .map((name) => `${name}=excluded.${name}`)
          .join(",")}`,
      ).run(...values);
    };
    const remove = (key: string) => db.query("DELETE FROM kv WHERE ns = ? AND key = ?").run(namespace, key);
    const request: KvRequest = async (path, init) => {
      try {
        const [route, query = ""] = path.split("?");
        if (route === "/keys") {
          const options = new URLSearchParams(query);
          const limit = Number(options.get("limit") ?? "1000");
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
            throw new Error("limit must be an integer from 1 to 1000");
          const prefix = options.get("prefix") ?? "";
          const cursor = options.get("cursor") ?? "";
          // Use SQL pagination rather than the runtime's capped binding list operation.
          const page = db
            .query<{ key: string }, [string, string, string, string, number, number]>(
              `SELECT key FROM kv WHERE ns = ? AND substr(key, 1, length(?)) = ? AND key > ? AND (${expiry} IS NULL OR ${expiry} > ?) ORDER BY key LIMIT ?`,
            )
            .all(namespace, prefix, prefix, cursor, readAt, limit + 1);
          const keys = page.slice(0, limit).map((row) => row.key);
          return Response.json({ keys, cursor: page.length > limit ? keys[keys.length - 1] : null });
        }
        if (route.startsWith("/keys/")) {
          const key = decodeURIComponent(route.slice(6));
          if (init?.method === "PUT") {
            put({ ...jsonObject(parseJsonValue(String(init.body))), key });
            return Response.json({ written: 1 });
          }
          if (init?.method === "DELETE") return Response.json({ deleted: remove(key).changes });
          const record = read(key);
          return record.value === null
            ? Response.json({ error: "key not found" }, { status: 404 })
            : Response.json(record);
        }
        const verb = route.slice("/bulk/".length);
        if (!route.startsWith("/bulk/") || !["get", "put", "delete"].includes(verb))
          throw new Error("unknown local KV operation");
        const entries = parseJsonValue(String(init?.body));
        if (!Array.isArray(entries) || entries.length > 100)
          throw new Error("bulk request must be an array of at most 100 entries");
        if (verb !== "put" && !entries.every(isString)) throw new Error("bulk keys must be strings");
        if (verb === "get") return Response.json(entries.map((key) => read(String(key))));
        return Response.json(
          db.transaction(() => {
            let changed = 0;
            for (const entry of entries) {
              if (verb === "put") {
                put(entry);
                changed++;
              } else changed += remove(String(entry)).changes;
            }
            return { [verb === "put" ? "written" : "deleted"]: changed, failures: [] };
          })(),
        );
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    };
    return { request, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
