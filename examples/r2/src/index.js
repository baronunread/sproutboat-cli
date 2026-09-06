// R2: S3-style object storage.
//
//   curl -X PUT localhost:8080/notes.txt -d 'the file contents'
//   curl -i localhost:8080/notes.txt          # body + etag
//   curl localhost:8080/
//
// Keep objects small. An object is held whole in memory on both the way in and
// the way out — see the R2 warning in the docs before storing anything large.

export default {
  fetch(request) {
    const key = new URL(request.url).pathname.slice(1);

    if (!key) {
      const objects = env.FILES.list().objects;
      return new Response(objects.map((o) => `${o.key}\t${o.size}\n`).join(""));
    }

    if (request.method === "PUT") {
      env.FILES.put(key, request.body || "");
      return new Response("stored\n", { status: 201 });
    }
    if (request.method === "DELETE") {
      env.FILES.delete(key);
      return new Response(null, { status: 204 });
    }

    const object = env.FILES.get(key);
    if (!object) return new Response("not found\n", { status: 404 });
    return new Response(object.body, { headers: { etag: object.etag } });
  },
};
