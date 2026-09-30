import { createServer } from "node:http";
import { dispatch } from "../fixtures/app.js";
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1048576) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const response = await dispatch(
      new Request("http://localhost" + req.url, { method: req.method, headers }),
      Buffer.concat(chunks).toString("utf8"),
      process.env.BENCH_UPSTREAM,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("adapter error");
  }
});
server.listen(Number(process.env.PORT || 8080), "127.0.0.1");
