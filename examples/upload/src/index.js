// Counts an upload as it streams in, and says how far apart its first and last chunks
// arrived. Memory stays flat however large the upload is: the server pauses the
// connection while the handler hasn't read what already arrived.
export default {
  async fetch(request) {
    if (request.method !== "POST" && request.method !== "PUT") return new Response("POST a body to count it\n");
    const reader = request.body.getReader();
    let bytes = 0;
    let chunks = 0;
    let first = 0;
    let last = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      last = Date.now();
      if (!first) first = last;
      bytes += value.length;
      chunks++;
    }
    return Response.json({ bytes, chunks, spreadMs: last - first });
  },
};
