// D1: a SQL database. prepare().bind().run() / .first() / .all(), all synchronous.
//
//   curl -X POST localhost:8080/ -d '{"title":"read the docs"}'
//   curl localhost:8080/

export default {
  fetch(request) {
    env.DB.exec(
      "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, done INTEGER DEFAULT 0)",
    );

    if (request.method === "POST") {
      const { title } = JSON.parse(request.body || "{}");
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
