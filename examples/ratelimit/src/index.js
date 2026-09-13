// Rate limiting: env.NAME.limit({ key }) -> { success, resetAt }, a fixed
// window of `limit` calls per `period` seconds, per key.
//
//   for i in 1 2 3 4; do curl localhost:8080/limited; done   # the 4th is 429

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/limited") return new Response("ratelimit demo: hit /limited\n");
    const { success, resetAt } = env.API.limit({ key: "demo" });
    if (!success) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      return new Response("slow down\n", { status: 429, headers: { "retry-after": String(retryAfter) } });
    }
    return new Response("ok\n");
  },
};
