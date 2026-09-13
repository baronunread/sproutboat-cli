// Service bindings: env.PEER.fetch() reaches another deployment on the same
// node directly, through the node's edge - no public URL, no extra hop out
// to the internet and back. `service` in sproutboat.jsonc names the target
// deployment; `binding` is what this handler calls it.
//
//   curl "localhost:8080/?name=sprout"

export default {
  fetch(request) {
    const url = new URL(request.url);
    return env.GREETER.fetch(
      new Request(`https://internal/?name=${encodeURIComponent(url.searchParams.get("name") || "there")}`),
    );
  },
};
