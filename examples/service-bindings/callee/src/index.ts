// The callee: an ordinary handler, deployed like any other. Nothing here knows it is being
// reached through a service binding rather than from the internet. That is the point.

export default {
  async fetch(request) {
    const name = new URL(request.url).searchParams.get("name") ?? "there";
    return new Response(`hello, ${name}, from the callee\n`);
  },
} satisfies ExportedHandler;
