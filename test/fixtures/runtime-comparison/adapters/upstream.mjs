import { createServer } from "node:http";
const body = Buffer.alloc(4096, "x");
createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/health") {
    response.end("ok");
    return;
  }
  const delay = Number(url.searchParams.get("delay") || 0);
  if (![0, 10, 50, 200].includes(delay)) {
    response.writeHead(400);
    response.end();
    return;
  }
  setTimeout(() => {
    response.writeHead(url.searchParams.get("fail") === "1" ? 503 : 200, {
      "content-type": "application/octet-stream",
      "content-length": body.length,
    });
    response.end(body);
  }, delay);
}).listen(Number(process.env.PORT), "127.0.0.1");
