// Outbound fetch: fetch() works, but only to a host named in `outbound` in
// sproutboat.jsonc - anything else is refused before it leaves the process.
//
//   curl localhost:8080/          # fetches the allowlisted host
//   curl localhost:8080/blocked   # fetch()es a host NOT on the allowlist

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/blocked") {
      try {
        await fetch("https://sproutboat.com/");
        return new Response("should not have reached here\n", { status: 500 });
      } catch (e) {
        return new Response(`blocked: ${e.message}\n`, { status: 403 });
      }
    }
    const res = await fetch("https://example.com/");
    return new Response(`example.com answered with ${res.status}\n`);
  },
};
