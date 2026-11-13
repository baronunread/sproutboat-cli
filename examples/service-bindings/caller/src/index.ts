// Service bindings: env.GREETER.fetch() reaches another deployment through the platform's edge, with
// no public URL and no trip out to the internet and back. `service` in sproutboat.jsonc names the target
// deployment; `binding` is what this handler calls it.

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "there";
    return env.GREETER.fetch(new Request(`https://internal/?name=${encodeURIComponent(name)}`));
  },
} satisfies ExportedHandler<Env>;
