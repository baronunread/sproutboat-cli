// Input validation: plain functions from untrusted input to a typed value or a list of what is wrong. No library,
// nothing here touches the runtime, so it is tested on its own (test/validate.test.ts).

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const MAX_TITLE = 200;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTitle(value: unknown): Parsed<string> {
  if (typeof value !== "string") return fail("title must be a string");
  const title = value.trim();
  if (title.length === 0) return fail("title must not be empty");
  if (title.length > MAX_TITLE) return fail(`title must be at most ${MAX_TITLE} characters`);
  return { ok: true, value: title };
}

/** A task id from a path segment: a positive integer that fits in a JavaScript number exactly. */
export function parseId(raw: string): number | null {
  return /^[1-9][0-9]{0,14}$/.test(raw) ? Number(raw) : null;
}

export function parseNewTask(body: unknown): Parsed<{ title: string }> {
  if (!isRecord(body)) return fail("the body must be a JSON object");
  const unknown = Object.keys(body).filter((key) => key !== "title");
  if (unknown.length > 0) return fail(`unknown fields: ${unknown.join(", ")}`);
  const title = parseTitle(body.title);
  return title.ok ? { ok: true, value: { title: title.value } } : title;
}

export interface TaskPatch {
  title?: string;
  done?: boolean;
}

export function parseTaskPatch(body: unknown): Parsed<TaskPatch> {
  if (!isRecord(body)) return fail("the body must be a JSON object");
  const unknown = Object.keys(body).filter((key) => key !== "title" && key !== "done");
  if (unknown.length > 0) return fail(`unknown fields: ${unknown.join(", ")}`);
  const patch: TaskPatch = {};
  const errors: string[] = [];
  if ("title" in body) {
    const title = parseTitle(body.title);
    if (title.ok) patch.title = title.value;
    else errors.push(...title.errors);
  }
  if ("done" in body) {
    if (typeof body.done === "boolean") patch.done = body.done;
    else errors.push("done must be true or false");
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(patch).length === 0) return fail("send title, done or both");
  return { ok: true, value: patch };
}

export interface ListQuery {
  limit: number;
  /** Keyset pagination: only tasks with an id greater than this. */
  after: number;
  done?: boolean;
}

export function parseListQuery(params: URLSearchParams): Parsed<ListQuery> {
  const errors: string[] = [];
  const query: ListQuery = { limit: DEFAULT_LIMIT, after: 0 };

  const limit = params.get("limit");
  if (limit !== null) {
    if (/^[0-9]{1,4}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= MAX_LIMIT) query.limit = Number(limit);
    else errors.push(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const after = params.get("after");
  if (after !== null) {
    // 0 is "from the start", which is what a client sends for the first page.
    const id = after === "0" ? 0 : parseId(after);
    if (id === null) errors.push("after must be 0 or a task id");
    else query.after = id;
  }
  const done = params.get("done");
  if (done !== null) {
    if (done === "true" || done === "false") query.done = done === "true";
    else errors.push("done must be true or false");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: query };
}
