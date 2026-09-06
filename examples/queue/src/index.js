// Queues: a producer in fetch(), a consumer in queue().
//
//   curl -X POST localhost:8080/ -d '{"email":"someone@example.com"}'
//   curl localhost:8080/          # the consumer's log, a moment later
//
// send() returns immediately; the batch is delivered to queue() out of band,
// which is the point — the request does not wait for the work.

export default {
  fetch(request) {
    schema();
    if (request.method === "POST") {
      env.JOBS.send(JSON.parse(request.body || "{}"));
      return new Response("queued\n", { status: 202 });
    }
    return new Response(JSON.stringify(env.DB.prepare("SELECT * FROM sent ORDER BY id").all().results), {
      headers: { "content-type": "application/json" },
    });
  },

  queue(batch) {
    schema();
    for (const message of batch.messages) {
      env.DB.prepare("INSERT INTO sent (email, at) VALUES (?, ?)")
        .bind(String(message.body.email || "?"), new Date().toISOString())
        .run();
      message.ack(); // without this the message is redelivered
    }
  },
};

function schema() {
  env.DB.exec("CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, at TEXT)");
}
