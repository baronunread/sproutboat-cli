// Outbound fetch: fetch() reaches any public host with no config, and never a
// private or reserved address - that is refused before it connects.
//
//   curl localhost:8080/          # fetches a public host
//   curl localhost:8080/blocked   # fetch()es the cloud metadata address

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/blocked") {
      try {
        await fetch("http://169.254.169.254/latest/meta-data/");
        return new Response("should not have reached here\n", { status: 500 });
      } catch (e) {
        return new Response(`blocked: ${e.message}\n`, { status: 403 });
      }
    }
    const res = await fetch("https://example.com/");
    return new Response(`example.com answered with ${res.status}\n`);
  },
};
