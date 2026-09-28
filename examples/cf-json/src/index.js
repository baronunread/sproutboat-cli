// Adapted from Cloudflare's Return JSON example.
export default {
  fetch() {
    return Response.json({ hello: "world" });
  },
};
