// ctx.waitUntil: work that must run, but that the response should not wait for.

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/check") {
      return new Response((await env.LOG.get("last")) ?? "unset\n");
    }
    // The response goes out now; the write finishes in the background.
    ctx.waitUntil(env.LOG.put("last", String(Date.now())));
    return new Response("ok\n");
  },
} satisfies ExportedHandler<Env>;
