// A stand-in for a native child under fault injection (#276).
//   stall: /body sends headers and part of a body, then never finishes it.
//   exit:  /body writes a line (with a "secret") to stderr and exits mid-request.
const mode = process.argv[2];
const port = Number(process.env.PORT);
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    if (new URL(request.url).pathname !== "/body") return new Response("ok");
    if (mode === "exit") {
      console.error("fatal: lost connection using token hunter2-secret");
      process.exit(7);
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    return new Response(stream, { headers: { "content-length": "100" } });
  },
});
console.error("fault-server listening");
setInterval(() => {}, 1000);
