/**
 * `sproutboat r2 object get | put | delete <bucket>/<key>`, with Wrangler's flags. On a Cloud endpoint an object lives in the
 * app's own bucket on its host (`/v1/apps/<app>/r2/<BUCKET>/objects/<key>`, docs/host-data.md in the cloud repo), and
 * `<bucket>` is the binding name from `r2_buckets`. Self-hosted Community can read an object (`/api/r2/<id>/objects/<key>`)
 * but has no route to write or delete one: its 404 is reported as not supported yet.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { authHeaders, CloudError, explainApiFailure, parseBody } from "./cloud";
import { isString } from "./json";
import { dim, ok } from "./style";

export const GET_USAGE = "r2 object get <bucket>/<key> [--file <path> | --pipe]";
export const PUT_USAGE =
  "r2 object put <bucket>/<key> (--file <path> | --pipe) [--content-type <type>] [--cache-control <v>] [--content-disposition <v>] [--content-encoding <v>] [--content-language <v>] [--expires <date>]";
export const DELETE_USAGE = "r2 object delete <bucket>/<key>";
/** What one object may be through the Cloud API for now (it is buffered in memory on the way). */
export const OBJECT_MAX_BYTES = 64 * 1024 * 1024;

export class R2UsageError extends Error {
  constructor(
    message: string,
    readonly usage: string,
  ) {
    super(message);
  }
}

export type ObjectFlags = {
  file?: string;
  pipe: boolean;
  contentType?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  cacheControl?: string;
  expires?: string;
  apiUrl?: string;
  account?: string;
};

/** `{bucket}/{key}`: the bucket is everything before the first slash, the key everything after it. */
export type ObjectPath = { bucket: string; key: string };

export function parseObjectPath(path: string | undefined, usage: string): ObjectPath {
  const slash = path?.indexOf("/") ?? -1;
  if (path === undefined || slash <= 0 || slash === path.length - 1)
    throw new R2UsageError("the object path must be <bucket>/<key>", usage);
  return { bucket: path.slice(0, slash), key: path.slice(slash + 1) };
}

export function parseObjectArgs(args: readonly string[], usage: string) {
  const flags: ObjectFlags = { pipe: false };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined;
    const value = () => {
      const next = inline ?? args[(index += 1)];
      if (next === undefined || (inline === undefined && next.startsWith("--")))
        throw new R2UsageError(`${name} needs a value`, usage);
      return next;
    };
    switch (name) {
      case "--file":
      case "-f":
        flags.file = value();
        break;
      case "--pipe":
      case "-p":
        flags.pipe = true;
        break;
      case "--content-type":
      case "--ct":
        flags.contentType = value();
        break;
      case "--content-disposition":
      case "--cd":
        flags.contentDisposition = value();
        break;
      case "--content-encoding":
      case "--ce":
        flags.contentEncoding = value();
        break;
      case "--content-language":
      case "--cl":
        flags.contentLanguage = value();
        break;
      case "--cache-control":
      case "--cc":
        flags.cacheControl = value();
        break;
      case "--expires":
        flags.expires = value();
        break;
      case "--api-url":
        flags.apiUrl = value();
        break;
      case "--account":
        flags.account = value();
        break;
      case "--remote":
        break;
      case "--local":
        throw new R2UsageError(
          "--local is not supported for R2 objects yet (dev keeps them in its broker store); objects are read and written on the Cloud, so --remote is the only mode",
          usage,
        );
      case "--jurisdiction":
      case "-J":
      case "--storage-class":
      case "-s":
      case "--persist-to":
        throw new R2UsageError(`${name} is not supported`, usage);
      default:
        if (arg.startsWith("-")) throw new R2UsageError(`unknown option ${name}`, usage);
        positional.push(arg);
    }
  }
  return { positional, flags };
}

/** The headers a PUT carries: the object's HTTP metadata, as the Cloud route reads them. */
/** The object metadata headers a PUT carries; `x-object-cache-control` is the object's Cache-Control (docs/host-data.md). */
export type ObjectHeaders = {
  "content-type"?: string;
  "content-disposition"?: string;
  "content-encoding"?: string;
  "content-language"?: string;
  "x-object-cache-control"?: string;
  expires?: string;
};

export function metadataHeaders(flags: ObjectFlags, fileType: string | undefined): ObjectHeaders {
  const headers: ObjectHeaders = {};
  const type = flags.contentType ?? fileType;
  if (type) headers["content-type"] = type;
  if (flags.contentDisposition) headers["content-disposition"] = flags.contentDisposition;
  if (flags.contentEncoding) headers["content-encoding"] = flags.contentEncoding;
  if (flags.contentLanguage) headers["content-language"] = flags.contentLanguage;
  if (flags.cacheControl) headers["x-object-cache-control"] = flags.cacheControl;
  if (flags.expires) {
    const time = Date.parse(flags.expires);
    if (Number.isNaN(time)) throw new R2UsageError(`--expires: "${flags.expires}" is not a date`, PUT_USAGE);
    headers.expires = new Date(time).toUTCString();
  }
  return headers;
}

export type ObjectIo = {
  log(line: string): void;
  note(line: string): void;
  stdout: { write(bytes: Uint8Array): void };
};

/** How the command reaches the objects of one bucket. */
export type ObjectTarget = {
  community: boolean;
  bucket: string;
  app: string;
  request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    init?: { body?: Uint8Array<ArrayBuffer>; headers?: ObjectHeaders },
  ): Promise<Response>;
};

async function explain(target: ObjectTarget, response: Response, method: string, key: string): Promise<never> {
  const text = await response.text().catch(() => "");
  const body = parseBody(text);
  if (response.status === 404) {
    if (target.community && method !== "GET")
      throw new CloudError(
        `${method === "PUT" ? "writing" : "deleting"} R2 objects is not supported on self-hosted Community yet (this endpoint has no such route); read-only: r2 object get`,
      );
    if (body?.reason === "no-bucket" || (target.community && !isString(body?.error)))
      throw new CloudError(`no R2 bucket "${target.bucket}"${target.community ? "" : ` for ${target.app}`}`);
    if (body?.reason === "no-object") throw new CloudError("The specified key does not exist.");
    if (isString(body?.error) && /no such app/i.test(body.error))
      throw new CloudError(`${target.app} is not deployed yet, so it has no bucket: run \`sproutboat deploy\` first`);
    throw new CloudError(`${key}: not found`);
  }
  if (response.status === 501)
    throw new CloudError(
      `the host that runs ${target.app} does not support R2 objects yet; ask the operator to update its agent`,
    );
  if (response.status === 413)
    throw new CloudError(
      `the object is larger than ${OBJECT_MAX_BYTES / 1024 / 1024} MiB, the most the Cloud takes through this command for now`,
    );
  if (response.status === 403 && body?.need)
    throw new CloudError(
      `this key lacks the ${String(body.need)} permission (see \`sproutboat whoami\` for this key's access)`,
    );
  throw new CloudError(explainApiFailure(response.status, text, false));
}

/** Where `get` writes: --file, stdout with --pipe, otherwise ./<key> (Wrangler's default), creating folders. */
export async function getObject(
  target: ObjectTarget,
  key: string,
  flags: ObjectFlags,
  io: ObjectIo,
  cwd: string,
): Promise<void> {
  if (flags.file !== undefined && flags.pipe) throw new R2UsageError("pass --file or --pipe, not both", GET_USAGE);
  const response = await target.request("GET", key);
  if (!response.ok) return explain(target, response, "GET", key);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (flags.pipe) {
    io.stdout.write(bytes);
    return;
  }
  const path = resolve(cwd, flags.file ?? key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  io.note(`${ok(`Downloaded "${key}" from "${target.bucket}"`)} ${dim(`to ${path} (${bytes.byteLength} bytes)`)}`);
}

export async function putObject(
  target: ObjectTarget,
  key: string,
  flags: ObjectFlags,
  io: ObjectIo,
  cwd: string,
  readStdin: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<void> {
  if ((flags.file === undefined) === !flags.pipe)
    throw new R2UsageError("you must provide either --file or --pipe", PUT_USAGE);
  let bytes: Uint8Array<ArrayBuffer>;
  let fileType: string | undefined;
  if (flags.file !== undefined) {
    const path = resolve(cwd, flags.file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new CloudError(`${flags.file}: no such file`);
    if (statSync(path).size > OBJECT_MAX_BYTES)
      throw new CloudError(
        `${flags.file} is larger than ${OBJECT_MAX_BYTES / 1024 / 1024} MiB, the most the Cloud takes through this command for now`,
      );
    bytes = new Uint8Array(readFileSync(path));
    fileType = Bun.file(path).type.split(";")[0];
    if (fileType === "application/octet-stream") fileType = undefined;
  } else {
    bytes = await readStdin();
    if (bytes.byteLength > OBJECT_MAX_BYTES)
      throw new CloudError(
        `the piped object is larger than ${OBJECT_MAX_BYTES / 1024 / 1024} MiB, the most the Cloud takes through this command for now`,
      );
  }
  const headers = metadataHeaders(flags, fileType);
  const response = await target.request("PUT", key, { body: bytes, headers });
  if (!response.ok) return explain(target, response, "PUT", key);
  await response.body?.cancel();
  io.note(`${ok(`Uploaded "${key}" to "${target.bucket}"`)} ${dim(`(${bytes.byteLength} bytes)`)}`);
}

export async function deleteObject(target: ObjectTarget, key: string, io: ObjectIo): Promise<void> {
  const response = await target.request("DELETE", key);
  if (!response.ok) return explain(target, response, "DELETE", key);
  await response.body?.cancel();
  io.note(ok(`Deleted "${key}" from "${target.bucket}"`));
}

/** A Cloud app's bucket: `/v1/apps/<app>/r2/<BUCKET>/objects/<key>` with the key's slashes kept. */
export function cloudTarget(apiUrl: string, token: string, app: string, bucket: string): ObjectTarget {
  return {
    community: false,
    bucket,
    app,
    request: (method, key, init = {}) =>
      fetch(
        `${apiUrl}/v1/apps/${app}/r2/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
        {
          method,
          headers: { ...authHeaders(token), ...init.headers },
          body: init.body === undefined ? undefined : init.body,
        },
      ),
  };
}

/** A Community bucket by its resource id: the read route exists, the write and delete routes do not (their 404 says so). */
export function communityTarget(apiUrl: string, token: string, app: string, bucket: string, id: string): ObjectTarget {
  return {
    community: true,
    bucket,
    app,
    request: (method, key, init = {}) =>
      fetch(`${apiUrl}/api/r2/${id}/objects/${encodeURIComponent(key)}`, {
        method,
        headers: { "x-api-key": token, ...init.headers },
        body: init.body === undefined ? undefined : init.body,
      }),
  };
}
