// Static assets: files served from a directory, plus an API route for the handler.

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/time") {
      return Response.json({ now: new Date().toISOString() });
    }
    // Anything else is a file. In a standalone build the files are compiled into the binary,
    // so there is nothing beside it on disk.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
