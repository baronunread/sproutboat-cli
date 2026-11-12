// The smallest Sproutboat app: one fetch handler and one var, no bindings.

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "world";
    return new Response(`${env.GREETING}, ${name}!\n`);
  },
} satisfies ExportedHandler<Env>;
