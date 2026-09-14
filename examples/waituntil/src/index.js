// ctx.waitUntil: work that must run but that the response shouldn't wait on.
//
//   curl localhost:8080/         # returns immediately
//   curl localhost:8080/check    # the background write already landed

export default {
  fetch(request, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/check") {
      return new Response(env.LOG.get("last") || "unset\n");
    }
    ctx.waitUntil(Promise.resolve().then(() => env.LOG.put("last", String(Date.now()))));
    return new Response("ok\n");
  },
};
