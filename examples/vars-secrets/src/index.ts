// `vars` are plain text in sproutboat.jsonc, baked in at build time. `secrets` never enter the build:
// they are set with `sproutboat secrets put` (or .dev.vars locally) and read from env like any binding.
//
// A standalone binary reads its secrets from the process environment, lazily: it starts without them
// and only throws the first time a handler touches one that is missing.

export default {
  async fetch(request, env) {
    return new Response(`${env.GREETING}, your key ends in ...${env.API_KEY.slice(-4)}\n`);
  },
} satisfies ExportedHandler<Env>;
