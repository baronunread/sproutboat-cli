// D1: a SQL database. prepare().bind().run() / .first() / .all(), all synchronous.
//
//   curl -X POST localhost:8080/ -d '{"title":"read the docs"}'
//   curl localhost:8080/
//
// The request body is read with `await request.text()`. From compatibility date
// 2026-10-21, `request.body` is a ReadableStream, as in Workers, so reading it as
// a string (`JSON.parse(request.body)`) only works at earlier dates.

export default {
  async fetch(request) {
    env.DB.exec(
      "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, done INTEGER DEFAULT 0)",
    );

    if (request.method === "POST") {
      const { title } = JSON.parse((await request.text()) || "{}");
      const res = env.DB.prepare("INSERT INTO todos (title) VALUES (?)")
        .bind(String(title || "untitled"))
        .run();
      return json({ id: res.meta.last_row_id }, 201);
    }

    return json(env.DB.prepare("SELECT id, title, done FROM todos ORDER BY id").all().results);
  },
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json" },
  });
}
