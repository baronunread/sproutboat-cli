// Outbound fetch: fetch() reaches any public host with no configuration, and never a private or
// reserved address: that is refused before it connects.

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === "/blocked") {
      try {
        await fetch("http://169.254.169.254/latest/meta-data/"); // the cloud metadata address
        return new Response("should not have reached here\n", { status: 500 });
      } catch (error) {
        return new Response(`blocked: ${error instanceof Error ? error.message : error}\n`, { status: 403 });
      }
    }
    const response = await fetch("https://example.com/");
    return new Response(`example.com answered with ${response.status}\n`);
  },
} satisfies ExportedHandler;
