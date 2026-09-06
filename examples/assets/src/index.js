// Static assets: files served straight from a directory, plus an API route.
//
//   curl localhost:8080/          # public/index.html
//   curl localhost:8080/api/time  # the handler

export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/api/time") {
      return new Response(JSON.stringify({ now: new Date().toISOString() }), {
        headers: { "content-type": "application/json" },
      });
    }
    // Anything else is a file. In a standalone build these are compiled into
    // the binary, so there is nothing beside it on disk.
    return env.ASSETS.fetch(request);
  },
};
