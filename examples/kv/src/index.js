// KV: a key-value store. At this compatibility date every binding call is synchronous,
// so there is no await. From 2026-10-25 KV calls return Promises, as on Workers: await them.
//
//   curl -X PUT localhost:8080/hello -d 'world'
//   curl localhost:8080/hello
//   curl localhost:8080/

export default {
  fetch(request) {
    const key = new URL(request.url).pathname.slice(1);

    if (!key) return new Response(env.NOTES.list("").join("\n") + "\n");

    if (request.method === "PUT") {
      env.NOTES.put(key, request.body || "");
      return new Response("saved\n", { status: 201 });
    }
    if (request.method === "DELETE") {
      env.NOTES.delete(key);
      return new Response(null, { status: 204 });
    }

    const value = env.NOTES.get(key);
    return value === null ? new Response("not found\n", { status: 404 }) : new Response(value + "\n");
  },
};
