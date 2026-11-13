// The peer of examples/kitchen-sink: its `PEER` service binding calls this app. Deploy this one first.
//
// A Worker as a class: fetch() answers HTTP, and every other public method is callable from a service binding
// over RPC, as `await env.PEER.random()`.
import { WorkerEntrypoint } from "cloudflare:workers";

interface Quote {
  content: string;
  author: string;
}

const QUOTES: Quote[] = [
  { content: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { content: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { content: "Programs must be written for people to read.", author: "Harold Abelson" },
];

const pick = (): Quote => QUOTES[Math.floor(Math.random() * QUOTES.length)]!;

export default class QuoteService extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/random") return Response.json(pick());
    if (pathname === "/") {
      return Response.json({
        service: "quote-service",
        about: "A small sproutboat app that kitchen-sink calls through a service binding.",
        routes: { "/random": "a quote as JSON: { content, author }" },
        rpc: "env.PEER.random() from a service binding",
        try: "/random",
      });
    }
    return Response.json({ error: "not found", path: pathname }, { status: 404 });
  }

  // RPC: callable as env.PEER.random() from a service binding.
  async random(): Promise<Quote> {
    return pick();
  }
}
