// A small JSON API on D1: tasks you can create, list, read, update and delete.
//
//   GET    /tasks?limit=20&after=<id>&done=false   a page of tasks
//   POST   /tasks            {"title": "..."}       create one (201 and a Location header)
//   GET    /tasks/:id                               read one
//   PATCH  /tasks/:id        {"title"?, "done"?}    change one
//   DELETE /tasks/:id                               remove one (204)
//
// The schema lives in migrations/ and is applied with `sproutboat d1 migrations apply DB`, not by the Worker.
import { createTask, deleteTask, getTask, listTasks, updateTask } from "./tasks.ts";
import { parseId, parseListQuery, parseNewTask, parseTaskPatch, type Parsed } from "./validate.ts";

const MAX_BODY_BYTES = 8 * 1024;

function problem(status: number, code: string, message: string, details?: string[], headers?: HeadersInit): Response {
  return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status, headers });
}

const invalid = (errors: string[]) => problem(400, "invalid_request", "the request is not valid", errors);
const notFound = () => problem(404, "not_found", "no such task");

/** The JSON body, or the response that refuses it: wrong media type, too large, or not JSON. */
async function readJson(request: Request): Promise<Parsed<unknown> | Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return problem(415, "unsupported_media_type", "send application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES)
    return problem(413, "payload_too_large", `the body is limited to ${MAX_BODY_BYTES} bytes`);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return invalid(["the body is not valid JSON"]);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/")
      return Response.json({ name: "api-d1", routes: ["GET /tasks", "POST /tasks", "GET /tasks/:id"] });

    if (pathname === "/tasks") {
      if (request.method === "GET") {
        const query = parseListQuery(url.searchParams);
        if (!query.ok) return invalid(query.errors);
        return Response.json(await listTasks(env.DB, query.value));
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        if (!body.ok) return invalid(body.errors);
        const input = parseNewTask(body.value);
        if (!input.ok) return invalid(input.errors);
        const task = await createTask(env.DB, input.value.title);
        return Response.json(task, { status: 201, headers: { location: `/tasks/${task.id}` } });
      }
      return problem(405, "method_not_allowed", "use GET or POST", undefined, { allow: "GET, POST" });
    }

    const route = /^\/tasks\/([^/]+)$/.exec(pathname);
    if (route) {
      const id = parseId(route[1]);
      if (id === null) return notFound();
      switch (request.method) {
        case "GET": {
          const task = await getTask(env.DB, id);
          return task ? Response.json(task) : notFound();
        }
        case "PATCH": {
          const body = await readJson(request);
          if (body instanceof Response) return body;
          if (!body.ok) return invalid(body.errors);
          const patch = parseTaskPatch(body.value);
          if (!patch.ok) return invalid(patch.errors);
          const task = await updateTask(env.DB, id, patch.value);
          return task ? Response.json(task) : notFound();
        }
        case "DELETE":
          return (await deleteTask(env.DB, id)) ? new Response(null, { status: 204 }) : notFound();
        default:
          return problem(405, "method_not_allowed", "use GET, PATCH or DELETE", undefined, {
            allow: "GET, PATCH, DELETE",
          });
      }
    }

    return problem(404, "not_found", "no such route");
  },
} satisfies ExportedHandler<Env>;
