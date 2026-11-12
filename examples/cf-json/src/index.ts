// Adapted from Cloudflare's Return JSON example.
export default {
  async fetch() {
    return Response.json({ hello: "world" });
  },
} satisfies ExportedHandler;
