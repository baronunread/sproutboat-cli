// Analytics Engine: writeDataPoint() records a point; query() reads the points back.
//
// Cloudflare's Analytics Engine is write-only from a Worker (reading it takes their separate SQL API), so
// query() is a Sproutboat extension: no second API to stand up just to see what you wrote.

export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { path?: string };
      env.EVENTS.writeDataPoint({ blobs: [body.path || "/"], doubles: [1], indexes: ["pageview"] });
      return new Response("recorded\n", { status: 202 });
    }
    const { rows } = await env.EVENTS.query({ limit: 20 });
    return Response.json(rows);
  },
} satisfies ExportedHandler<Env>;
