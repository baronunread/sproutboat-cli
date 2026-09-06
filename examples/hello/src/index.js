// The smallest Sproutboat app: one fetch handler, no bindings.
// `env` is a global, not a parameter.

export default {
  fetch(request) {
    const name = new URL(request.url).searchParams.get("name") || "world";
    return new Response(`${env.GREETING}, ${name}!\n`);
  },
};
