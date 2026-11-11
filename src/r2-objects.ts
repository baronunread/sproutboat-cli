/**
 * `sproutboat r2 object get | put | delete <bucket>/<key>`, with Wrangler's flags. On a Cloud endpoint an object lives in the
 * app's own bucket on its host (`/v1/apps/<app>/r2/<BUCKET>/objects/<key>`, docs/host-data.md in the cloud repo), and
 * `<bucket>` is the binding name from `r2_buckets`. Self-hosted Community can read an object (`/api/r2/<id>/objects/<key>`)
 * but has no route to write or delete one: its 404 is reported as not supported yet.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { authHeaders, CloudError, explainApiFailure, parseBody } from "./cloud";
import { dataErrorMessage } from "./data-errors";
import { isString } from "./json";
import { dim, ok } from "./style";

export const GET_USAGE = "r2 object get <bucket>/<key> [--file <path> | --pipe]";
export const PUT_USAGE =
  "r2 object put <bucket>/<key> (--file <path> | --pipe) [--content-type <type>] [--cache-control <v>] [--content-disposition <v>] [--content-encoding <v>] [--content-language <v>] [--expires <date>]";
export const DELETE_USAGE = "r2 object delete <bucket>/<key>";
/** What one object may be through the Cloud API (a PUT is refused over it before any host is called). */
export const OBJECT_MAX_BYTES = 64 * 1024 * 1024;
/** The longest key, in bytes of UTF-8. */
export const KEY_MAX_BYTES = 1024;

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

/**
 * The rules the Cloud applies to a key (docs/host-data.md, "R2 keys"), so a bad one is refused here with a reason
 * instead of coming back as a 400: 1 to 1024 bytes of UTF-8, no control character (C0, DEL, C1), no backslash, and no
 * empty, `.` or `..` segment. Returns the problem, or undefined when the key is fine.
 */
export function keyProblem(key: string): string | undefined {
  if (key.length === 0) return "the key is empty";
  try {
    encodeURIComponent(key); // throws on a lone surrogate, which has no UTF-8 form
  } catch {
    return "the key is not valid UTF-8";
  }
  const bytes = new TextEncoder().encode(key).length;
  if (bytes > KEY_MAX_BYTES) return `the key is ${bytes} bytes; at most ${KEY_MAX_BYTES}`;
  for (let at = 0; at < key.length; at += 1) {
    const code = key.charCodeAt(at);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
      return `the key has a control character (U+${code.toString(16).toUpperCase().padStart(4, "0")}) at position ${at + 1}`;
    if (code === 0x5c) return "the key has a backslash; use / between folders";
  }
  const segments = key.split("/");
  if (segments.some((part) => part === "")) return 'the key has an empty segment: no leading, trailing or doubled "/"';
  const dots = segments.find((part) => part === "." || part === "..");
  if (dots) return `the key has a "${dots}" segment; a key is a name, not a path`;
  return undefined;
}

export function parseObjectPath(path: string | undefined, usage: string): ObjectPath {
  const slash = path?.indexOf("/") ?? -1;
  if (path === undefined || slash <= 0) throw new R2UsageError("the object path must be <bucket>/<key>", usage);
  const key = path.slice(slash + 1);
  const problem = keyProblem(key);
  if (problem)
    throw new R2UsageError(
      `${path.slice(0, slash)}/${key.length > 60 ? `${key.slice(0, 57)}...` : key}: ${problem}`,
      usage,
    );
  return { bucket: path.slice(0, slash), key };
}

/** Read stdin up to `max` bytes; a longer input stops the read instead of filling memory. */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
  tooLong: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) throw tooLong();
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
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
  if (target.community) {
    if (response.status === 404) {
      if (method !== "GET")
        throw new CloudError(
          `${method === "PUT" ? "writing" : "deleting"} R2 objects is not supported on self-hosted Community yet (this endpoint has no such route); read-only: r2 object get`,
        );
      throw new CloudError(isString(body?.error) ? `${key}: not found` : `no R2 bucket "${target.bucket}"`);
    }
    throw new CloudError(explainApiFailure(response.status, text, false));
  }
  const message = dataErrorMessage(
    { status: response.status, body, headers: response.headers },
    { project: target.app, product: "R2", noun: "bucket", name: target.bucket, write: method !== "GET" },
  );
  if (message) throw new CloudError(message);
  if (response.status === 404) {
    if (isString(body?.error) && /no such app/i.test(body.error))
      throw new CloudError(`${target.app} is not deployed yet, so it has no bucket: run \`sproutboat deploy\` first`);
    throw new CloudError(`${key}: not found`);
  }
  throw new CloudError(explainApiFailure(response.status, text, false));
}

/** The object's own type: the `x-object-content-type` header, present only when one was stored (`content-type` is always octet-stream). */
export function storedContentType(headers: Headers): string | undefined {
  return headers.get("x-object-content-type") ?? undefined;
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
  // The response's own content-type is always application/octet-stream; the object's type is x-object-content-type.
  const type = storedContentType(response.headers);
  io.note(
    `${ok(`Downloaded "${key}" from "${target.bucket}"`)} ${dim(`to ${path} (${bytes.byteLength} bytes${type ? `, ${type}` : ""})`)}`,
  );
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
        `${flags.file} is larger than ${OBJECT_MAX_BYTES / 1024 / 1024} MiB, the most the Cloud takes`,
      );
    bytes = new Uint8Array(readFileSync(path));
    fileType = Bun.file(path).type.split(";")[0];
    if (fileType === "application/octet-stream") fileType = undefined;
  } else {
    bytes = await readStdin();
    if (bytes.byteLength > OBJECT_MAX_BYTES)
      throw new CloudError(
        `the piped object is larger than ${OBJECT_MAX_BYTES / 1024 / 1024} MiB, the most the Cloud takes`,
      );
  }
  const headers = metadataHeaders(flags, fileType);
  const response = await target.request("PUT", key, { body: bytes, headers });
  if (!response.ok) return explain(target, response, "PUT", key);
  const answer = parseBody(await response.text().catch(() => ""));
  const etag = isString(answer?.etag) ? `, etag ${answer.etag}` : "";
  io.note(`${ok(`Uploaded "${key}" to "${target.bucket}"`)} ${dim(`(${bytes.byteLength} bytes${etag})`)}`);
}

export async function deleteObject(target: ObjectTarget, key: string, io: ObjectIo): Promise<void> {
  const response = await target.request("DELETE", key);
  if (!response.ok) return explain(target, response, "DELETE", key);
  await response.body?.cancel();
  io.note(ok(`Deleted "${key}" from "${target.bucket}"`));
}

/**
 * A Cloud app's bucket: `/v1/apps/<app>/r2/<BUCKET>/objects/<key>` with the key's slashes kept. A key never holds a dot
 * segment, a backslash or a control character (checked before this), so `encodeURIComponent` never writes the `%2e`,
 * `%2f` or `%5c` the Cloud refuses. The body is whole bytes, so the request always carries `content-length` (an
 * `x-declared-length` is only for a chunked body, which this never sends). A GET is not decompressed: the bytes written are
 * the bytes stored, whatever the transport says.
 */
export function cloudTarget(apiUrl: string, token: string, app: string, bucket: string): ObjectTarget {
  return {
    community: false,
    bucket,
    app,
    request: (method, key, init = {}) => {
      const headers = new Headers({ ...authHeaders(token), ...init.headers });
      if (init.body !== undefined) headers.set("content-length", String(init.body.byteLength));
      const path = key.split("/").map(encodeURIComponent).join("/");
      return fetch(`${apiUrl}/v1/apps/${app}/r2/${encodeURIComponent(bucket)}/objects/${path}`, {
        method,
        headers,
        body: init.body,
        decompress: false,
      });
    },
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
        decompress: false,
      }),
  };
}
