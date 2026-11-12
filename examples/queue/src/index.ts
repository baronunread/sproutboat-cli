// Queues: a producer in fetch(), a consumer in queue().
//
// send() returns once the message is stored; the batch is delivered to queue() out of band,
// which is the point: the request does not wait for the work.

interface Job {
  email: string;
}

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, at TEXT NOT NULL)";

// Created once per process by whichever handler runs first, fetch() or queue().
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
      const job = (await request.json()) as Job;
      await env.JOBS.send(job);
      return new Response("queued\n", { status: 202 });
    }

    const { results } = await env.DB.prepare("SELECT * FROM sent ORDER BY id").all();
    return Response.json(results);
  },

  async queue(batch, env) {
    await ensureSchema(env);
    for (const message of batch.messages) {
      await env.DB.prepare("INSERT INTO sent (email, at) VALUES (?, ?)")
        .bind(message.body.email, new Date().toISOString())
        .run();
      message.ack(); // a message that throws, or that you retry(), is delivered again
    }
  },
} satisfies ExportedHandler<Env, Job>;
