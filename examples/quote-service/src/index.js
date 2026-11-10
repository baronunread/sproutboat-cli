// The peer of examples/kitchen-sink: its `PEER` service binding calls this app.
// Deploy this one first (`sproutboat deploy` here), then kitchen-sink.
//
//   GET /random   a quote as JSON ({ content, author }), what kitchen-sink's /peer expects
//   random()      the same quote over RPC: `await env.PEER.random()`
import { WorkerEntrypoint } from "cloudflare:workers";

const QUOTES = [
  { content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { content: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { content: "Programs must be written for people to read.", author: "Harold Abelson" },
];

const pick = () => QUOTES[Math.floor(Math.random() * QUOTES.length)];

export default class QuoteService extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/random") {
      return new Response(JSON.stringify(pick()), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found", path: url.pathname }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // RPC: callable as env.PEER.random() from a service binding.
  async random() {
    return pick();
  }
}
