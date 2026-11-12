// D1: a SQL database. prepare().bind().run() / .first() / .all(), all awaited.

interface Todo {
  id: number;
  title: string;
  done: number;
}

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)";

// The table is created once per process, by the first request that needs it, and not on every request.
// For anything beyond a demo keep the schema in migrations: `sproutboat d1 migrations create DB init`.
let schema: Promise<unknown> | undefined;
async function ensureSchema(env: Env) {
  schema ??= env.DB.exec(SCHEMA);
  try {
    await schema;
  } catch (error) {
    schema = undefined; // a failed attempt is not cached
    throw error;
  }
}

export default {
  async fetch(request, env) {
    await ensureSchema(env);

    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { title?: string };
      const { meta } = await env.DB.prepare("INSERT INTO todos (title) VALUES (?)")
        .bind(body.title || "untitled")
        .run();
      return Response.json({ id: meta.last_row_id }, { status: 201 });
    }

    const { results } = await env.DB.prepare("SELECT id, title, done FROM todos ORDER BY id").all<Todo>();
    return Response.json(results);
  },
} satisfies ExportedHandler<Env>;
