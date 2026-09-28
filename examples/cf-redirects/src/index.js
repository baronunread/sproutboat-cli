// Adapted from Cloudflare's Bulk redirects example.
const redirects = new Map([
  ["/old-guide", "/guide"],
  ["/old-api", "/api"],
]);

export default {
  fetch(request) {
    const url = new URL(request.url);
    const destination = redirects.get(url.pathname);
    if (!destination) return new Response("Not found", { status: 404 });
    return new Response("", { status: 301, headers: { location: url.origin + destination } });
  },
};
