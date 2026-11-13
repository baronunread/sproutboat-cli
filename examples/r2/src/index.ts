// R2: S3-style object storage. The path is the key.
//
// Keep objects small: a request body is stored in one put. docs/r2-large-objects.md covers large files.

export default {
  async fetch(request, env) {
    const key = new URL(request.url).pathname.slice(1);

    if (!key) {
      const { objects } = await env.FILES.list();
      return new Response(objects.map((object) => `${object.key}\t${object.size}\n`).join(""));
    }

    switch (request.method) {
      case "PUT":
        await env.FILES.put(key, request.body);
        return new Response("stored\n", { status: 201 });
      case "DELETE":
        await env.FILES.delete(key);
        return new Response(null, { status: 204 });
      default: {
        const object = await env.FILES.get(key);
        if (!object) return new Response("not found\n", { status: 404 });
        const headers = new Headers({ etag: object.httpEtag });
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
      }
    }
  },
} satisfies ExportedHandler<Env>;
