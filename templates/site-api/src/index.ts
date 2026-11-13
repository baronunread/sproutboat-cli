// A static site and its API in one Worker.
//
// The files in public/ are served by the platform. The handler runs first only for /api/*, answers those routes, and
// hands everything else on to env.ASSETS, which serves the file (or public/404.html when there is none).
//
//   GET  /api/health              {"ok":true}
//   GET  /api/subscribers/count   {"count": 12}
//   POST /api/subscribe           {"email": "ada@example.com"}  ->  201, or 200 when it was already on the list

const MAX_EMAIL = 254;
// Deliberately loose: one @, something on each side, no spaces. The only real check of an address is mailing it.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

async function countSubscribers(kv: Env["SUBSCRIBERS"]): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "subscriber:", cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

async function subscribe(request: Request, env: Env): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return json({ error: "send application/json" }, 415);
  const body: unknown = await request.json().catch(() => null);
  const email =
    typeof body === "object" && body !== null && "email" in body && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";
  if (email.length === 0 || email.length > MAX_EMAIL || !EMAIL.test(email))
    return json({ error: "email must be an email address" }, 400);

  const key = `subscriber:${email}`;
  if ((await env.SUBSCRIBERS.get(key)) !== null) return json({ subscribed: true, already: true });
  await env.SUBSCRIBERS.put(key, JSON.stringify({ at: new Date().toISOString() }));
  return json({ subscribed: true, already: false }, 201);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (pathname === "/api/health") return json({ ok: true });
    if (pathname === "/api/subscribers/count") {
      if (request.method !== "GET") return json({ error: "use GET" }, 405, { allow: "GET" });
      return json({ count: await countSubscribers(env.SUBSCRIBERS) });
    }
    if (pathname === "/api/subscribe") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405, { allow: "POST" });
      return subscribe(request, env);
    }
    return json({ error: "no such route" }, 404);
  },
} satisfies ExportedHandler<Env>;
