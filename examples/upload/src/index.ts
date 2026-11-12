// Counts an upload as it streams in, and says how far apart its first and last chunks arrived.
// Memory stays flat however large the upload is: the server pauses the connection while the handler
// has not read what already arrived (request bodies stream from compatibility date 2026-10-27).

export default {
  async fetch(request) {
    const reader = request.body?.getReader();
    if (request.method === "GET" || !reader) return new Response("POST a body to count it\n");

    let bytes = 0;
    let chunks = 0;
    let first = 0;
    let last = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      last = Date.now();
      first ||= last;
      bytes += value.length;
      chunks++;
    }
    return Response.json({ bytes, chunks, spreadMs: last - first });
  },
} satisfies ExportedHandler;
