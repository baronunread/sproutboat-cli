// Adapted from Cloudflare's Read POST example.
export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Send a POST with JSON or text", { status: 405 });
    }
    const type = request.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      try {
        return Response.json({ received: await request.json() });
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
    }
    if (type.includes("text/plain")) {
      return new Response(await request.text());
    }
    return new Response("Use application/json or text/plain", { status: 415 });
  },
};
