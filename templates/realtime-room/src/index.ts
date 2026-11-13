// A realtime chat room: one Durable Object per room name, reached over WebSockets.
//
//   GET /                        the chat page
//   GET /rooms/:room?name=ada    upgrade to a WebSocket and join as "ada"
//   GET /rooms/:room/presence    who is in the room, as JSON
//
// The Room class lives here, in the entry module: the class a `durable_objects` binding names must be exported from
// it, and `sproutboat types` reads it from here to type `env.ROOMS` (so `room.presence()` is checked).
//
// The room holds its sockets with the WebSocket Hibernation API. The object never keeps the connections itself: it
// hands each one to `ctx.acceptWebSocket()` and is called back on `webSocketMessage` / `webSocketClose`, so a room
// with nobody talking can be unloaded and woken by the next frame. What it must remember about a socket is stored on
// the socket (`serializeAttachment`) or looked up by tag (`getWebSockets(tag)`), never in a field of this class,
// because fields do not survive hibernation.
import { DurableObject } from "cloudflare:workers";
import { PAGE } from "./page.ts";

const HISTORY_LIMIT = 50;
const MAX_TEXT = 500;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/;

export interface ChatMessage {
  from: string;
  text: string;
  at: number;
}

/** What the server sends. */
export type ServerFrame =
  | { type: "welcome"; name: string; presence: string[]; history: ChatMessage[] }
  | { type: "join"; name: string; presence: string[] }
  | { type: "leave"; name: string; presence: string[] }
  | ({ type: "message" } & ChatMessage)
  | { type: "error"; error: string };

/** Stored on each socket with `serializeAttachment`: it is still there after the object hibernates and wakes. */
interface Attachment {
  name: string;
  joinedAt: number;
}

/** A tag per name, so `getWebSockets(tag)` finds a user's socket without reading every attachment. */
const nameTag = (name: string) => `name:${name.toLowerCase()}`;

export class Room extends DurableObject<Env> {
  /** Who is here, as an RPC method: `await room.presence()` from the Worker. */
  presence(leaving?: string): string[] {
    const names: string[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const who = socket.deserializeAttachment() as Attachment | null;
      if (who && who.name !== leaving) names.push(who.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") ?? "";
    if (!NAME_PATTERN.test(name))
      return Response.json(
        { error: "name is 1 to 24 letters, digits, spaces, dots, dashes or underscores" },
        { status: 400 },
      );
    // Names are unique in a room; a closing socket can still be listed for a moment, so a quick reconnect may see this.
    if (this.ctx.getWebSockets(nameTag(name)).length > 0)
      return Response.json({ error: `${name} is already in this room` }, { status: 409 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected a WebSocket upgrade\n", { status: 426, headers: { upgrade: "websocket" } });

    // Answered by the runtime without waking the object: a client's keep-alive costs the room nothing. It is set on
    // the object, not the socket, so setting it on each connection is harmless.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [nameTag(name)]);
    server.serializeAttachment({ name, joinedAt: Date.now() } satisfies Attachment);

    const history = (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
    this.send(server, { type: "welcome", name, presence: this.presence(), history });
    this.broadcast({ type: "join", name, presence: this.presence() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const who = ws.deserializeAttachment() as Attachment | null;
    if (!who) return void ws.close(1011, "unknown connection");
    if (typeof message !== "string") return this.send(ws, { type: "error", error: "send text frames" });

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return this.send(ws, { type: "error", error: "frames are JSON" });
    }
    const text = typeof frame === "object" && frame !== null && "text" in frame ? frame.text : undefined;
    if (
      typeof frame !== "object" ||
      frame === null ||
      !("type" in frame) ||
      frame.type !== "chat" ||
      typeof text !== "string"
    )
      return this.send(ws, { type: "error", error: 'send {"type":"chat","text":"..."}' });
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT)
      return this.send(ws, { type: "error", error: `text is 1 to ${MAX_TEXT} characters` });

    const entry: ChatMessage = { from: who.name, text: trimmed, at: Date.now() };
    // Storage is the only memory that outlives hibernation: keep the last HISTORY_LIMIT messages.
    const history = (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
    history.push(entry);
    await this.ctx.storage.put("history", history.slice(-HISTORY_LIMIT));
    this.broadcast({ type: "message", ...entry });
  }

  webSocketClose(ws: WebSocket, code: number): void {
    const who = ws.deserializeAttachment() as Attachment | null;
    // 1005, 1006 and 1015 describe a close, they cannot be sent as one.
    ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, "closed");
    if (who) this.broadcast({ type: "leave", name: who.name, presence: this.presence(who.name) });
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.error("socket error", error instanceof Error ? error.message : String(error));
    ws.close(1011, "error");
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private broadcast(frame: ServerFrame, except?: WebSocket): void {
    const text = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(text);
      } catch {
        // A socket that is closing can still be listed, and has nothing to receive.
      }
    }
  }
}

const ROOM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

    const route = /^\/rooms\/([^/]+)(\/presence)?$/.exec(url.pathname);
    if (!route) return new Response("not found\n", { status: 404 });
    const [, name, presence] = route;
    if (!ROOM_NAME.test(name))
      return Response.json({ error: "a room name is 1 to 32 lowercase letters, digits or dashes" }, { status: 400 });

    // The same name is always the same object, wherever it runs, so everyone in a room reaches the same sockets.
    const room = env.ROOMS.getByName(name);
    if (presence) return Response.json(await room.presence());
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;
