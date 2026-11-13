// Rate limiting: env.API.limit({ key }) allows `limit` calls per `period` seconds for each key
// (the numbers are in sproutboat.jsonc).

// The period in sproutboat.jsonc. The Workers API says whether a call is allowed, not when the window ends,
// so a refusal can only say "try again within a period".
const PERIOD_SECONDS = 60;

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/limited") return new Response("ratelimit demo: hit /limited\n");

    const { success } = await env.API.limit({ key: "demo" });
    if (!success) {
      return new Response("slow down\n", { status: 429, headers: { "retry-after": String(PERIOD_SECONDS) } });
    }
    return new Response("ok\n");
  },
} satisfies ExportedHandler<Env>;
