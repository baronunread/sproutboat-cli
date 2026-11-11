/**
 * What the Cloud's data routes (`d1 execute`, `r2 object`) answer when something goes wrong, in words a person can act on.
 * The contract is the "Errors" table of docs/host-data.md in sproutboat-cloud: bodies are `{error, reason, ...}`, and
 * `reason` (never the text) decides what happened.
 */
import { isSafeInteger, isString, type JsonObject } from "./json";

/** Every status a data route can answer with besides success, so `makeCall` hands them back instead of throwing. */
export const DATA_ERROR_STATUSES = [400, 403, 404, 409, 411, 413, 422, 429, 501, 502, 503, 504, 507];

/** What the caller was doing, for the messages. */
export type DataContext = {
  project: string;
  /** "D1" or "R2". */
  product: "D1" | "R2";
  /** "database" or "bucket". */
  noun: "database" | "bucket";
  name: string;
  /** What the action is, for a missing grant: "read data", "change data". */
  write: boolean;
};

export type DataReply = { status: number; body?: JsonObject; headers?: Headers };

/** Not temporary: the host refuses remote writes to any database with backup capture on. */
export const CAPTURE_ACTIVE =
  "remote writes are not available for a database with backup capture on; write through your app";

const NOT_YET = "remote D1/R2 isn't available on this Cloud host yet";

/** Seconds to wait, from the body's `retry_after` or the `retry-after` header. */
function retryAfter(reply: DataReply): number | undefined {
  const fromBody = reply.body?.retry_after;
  if (isSafeInteger(fromBody) && fromBody > 0) return fromBody;
  const header = Number(reply.headers?.get("retry-after"));
  return Number.isSafeInteger(header) && header > 0 ? header : undefined;
}

const wait = (reply: DataReply) => {
  const seconds = retryAfter(reply);
  return seconds === undefined ? "try again shortly" : `try again in ${seconds} s`;
};

/** The grant a 403 says is missing, and how to get it. */
function missingGrant(need: string | undefined, product: DataContext["product"], write: boolean): string {
  const grant = need === "data:read" || need === "data:write" ? need : write ? "data:write" : "data:read";
  const what =
    grant === "data:write"
      ? product === "D1"
        ? "change data (SQL other than SELECT)"
        : "upload or delete objects"
      : product === "D1"
        ? "read data"
        : "download objects";
  const preset = grant === "data:write" ? "Deploy and data" : "Read data";
  return (
    `this key lacks the ${grant} grant, which ${what} needs. Ask a team owner to give it: Settings, API keys, ` +
    `the "${preset}" preset (or an API call that names \`data\`). A key made by \`sproutboat login\` has it for ` +
    `an owner, admin or developer; viewers never do. \`sproutboat whoami\` shows this key's access`
  );
}

/**
 * The message for a data-route answer that is not a success, or undefined when the status is not one this knows
 * (the caller then says what it sent). `sql-error` is not handled here: D1 keeps its statement index.
 */
export function dataErrorMessage(reply: DataReply, context: DataContext): string | undefined {
  const { status, body } = reply;
  const reason = isString(body?.reason) ? body.reason : undefined;
  const text = isString(body?.error) ? body.error : undefined;
  const { project, product, noun, name } = context;
  switch (status) {
    case 400:
      if (reason === "refused") return `the Cloud refused this SQL${text ? `: ${text}` : ""}`;
      if (reason === "invalid") {
        const path = isString(body?.path) ? body.path : undefined;
        const detail = text ? `: ${text}` : "";
        // The Cloud names the field: the object's "key", or the "database" or "bucket" (the binding name).
        if (path === "key") return `the Cloud rejected the object key${detail}`;
        if (path === "database" || path === "bucket") return `the Cloud rejected the ${path} name "${name}"${detail}`;
        return `the Cloud rejected the request${path ? ` (${path})` : ""}${detail}`;
      }
      return undefined;
    case 403:
      if (reason === "forbidden" || body?.need !== undefined)
        return missingGrant(isString(body?.need) ? body.need : undefined, product, context.write);
      return undefined;
    case 404:
      if (reason === "no-database")
        return `${project} has no ${product} ${noun} "${name}" on its host yet; a database exists once the deployed app has used it`;
      if (reason === "no-bucket") return `${project} has no ${product} ${noun} "${name}" on its host yet`;
      if (reason === "no-object") return "The specified key does not exist.";
      return `${project} is not deployed yet, so it has no ${noun}: run \`sproutboat deploy\` first`;
    case 409:
      if (reason === "capture-active") return CAPTURE_ACTIVE;
      if (reason === "bad-database") return `the ${noun} file on the host is not a valid database; ask the operator`;
      return undefined;
    case 411:
      return "the Cloud needs the upload's length up front (content-length, or x-declared-length for a chunked body)";
    case 413:
      if (product === "D1")
        return `${text ?? "too large"} (a request may carry at most 4 MiB of SQL and return at most 8 MiB)`;
      return `${text ?? "too large"} (an object may be at most 64 MiB through this route)`;
    case 422:
      if (reason === "memory-limit") return `the query needs more memory than the host allows; make it smaller`;
      return undefined;
    case 429:
      return `too many data requests for this team; ${wait(reply)}`;
    case 501:
      return `${NOT_YET} (this Cloud has no data routes)`;
    case 502: {
      // Only an answer with no reason (an older Cloud, a proxy) means the routes are missing. A Cloud that has them says what failed.
      if (reason === undefined)
        return `${NOT_YET} (the host's agent answered something unexpected: ask the operator to update it)`;
      return `the host's agent failed (${reason})${text ? `: ${text}` : ""}. Nothing here says the request was applied; ${wait(reply)}, and ask the operator if it keeps happening`;
    }
    case 503:
      if (reason === "busy") return `the host is busy with other data requests; ${wait(reply)}`;
      if (reason === "audit-unavailable")
        return `the Cloud could not record this request in its audit log, so it was not served. A write may already have been applied: read before retrying`;
      if (reason === "host-unavailable")
        return `${NOT_YET}: the host that runs ${project} is down, unreachable or has no D1/R2 service; ${wait(reply)}`;
      return NOT_YET;
    case 504: {
      // `committed` is the Cloud's own word: "no" is the agent's 25 s deadline (rolled back), "unknown" is the Cloud's 35 s
      // timeout, after which the host may have applied the request. No `committed` (an older Cloud) is treated as unknown.
      if (body?.committed === "no")
        return product === "D1"
          ? "the query took longer than the 25 s limit and was rolled back: nothing was committed"
          : "the host took longer than 25 s: nothing was changed";
      if (!context.write) return "the host did not answer in time (the Cloud waits 35 s); try again shortly";
      return "the host did not answer in time (the Cloud waits 35 s); the write may or may not have been applied: read the data before you retry";
    }
    case 507:
      return `the host has no room left for this app's data (quota exceeded)`;
    default:
      return undefined;
  }
}
