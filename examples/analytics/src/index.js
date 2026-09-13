// Analytics Engine: writeDataPoint() records a point; query() reads them
// back. Cloudflare's AE is write-only from a Worker - reading it needs their
// separate SQL API - so query() here is a Sproutboat extension: no second
// API to stand up just to see what you wrote.
//
//   curl -X POST localhost:8080/ -d '{"path":"/pricing"}'
//   curl localhost:8080/                                    # points so far

export default {
  fetch(request) {
    if (request.method === "POST") {
      const body = JSON.parse(request.body || "{}");
      env.EVENTS.writeDataPoint({ blobs: [String(body.path || "/")], doubles: [1], indexes: ["pageview"] });
      return new Response("recorded\n", { status: 202 });
    }
    const { rows } = env.EVENTS.query({ limit: 20 });
    return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
  },
};
