# realtime-room

A chat room with presence, on Durable Objects and hibernating WebSockets. One object per room name; everyone connected to a room is connected to the same object.

It is standard Cloudflare Workers TypeScript: the same files run on Cloudflare unchanged. `Env` comes from `worker-configuration.d.ts`, which `sproutboat types` writes from `sproutboat.jsonc`; run it again after you change the bindings.

## What it shows

- `ctx.acceptWebSocket(socket, tags)` instead of `socket.accept()`: the object does not hold its connections, so a room with nobody talking can be unloaded and is woken by the next frame (`src/room.ts`).
- `socket.serializeAttachment()` for what a socket must remember (its name), and `getWebSockets(tag)` to find a socket by tag. Nothing is kept in a class field, because fields do not survive hibernation.
- `webSocketMessage`, `webSocketClose` and `webSocketError` as the object's handlers, and `setWebSocketAutoResponse` so a client's `ping` is answered without waking the room.
- Durable Object storage for the last 50 messages, replayed to whoever joins.
- An RPC method (`room.presence()`) called from the Worker, and `room.fetch(request)` to hand the upgrade to the object.
- Validation at the edge of the room: names, frame shape and size, one connection per name.

## Run it

```sh
npm install
sproutboat dev                       # http://localhost:8787, rebuilt on save
```

Open it in two browser tabs, pick a room, and talk to yourself. Or as one executable with its bindings inside it:

```sh
sproutboat build --standalone --target host
PORT=8080 ./dist/realtime-room
```

## Try it

The protocol is JSON text frames. Connect to `/rooms/<room>?name=<you>`:

```sh
npx wscat -c 'ws://localhost:8787/rooms/lobby?name=ada'
> {"type":"chat","text":"hello"}
< {"type":"message","from":"ada","text":"hello","at":1763000000000}
curl localhost:8787/rooms/lobby/presence       # ["ada"]
```

The server sends `welcome` (who is here and the history), `join`, `leave`, `message` and `error` frames. A room name is 1 to 32 lowercase letters, digits or dashes; a name is 1 to 24 letters, digits, spaces, dots, dashes or underscores, and is unique in its room.

## Test it

```sh
npm test                             # starts `sproutboat dev` and drives it over HTTP and WebSockets
BASE_URL=http://localhost:8080 npm test   # or drive a server that is already running
npm run typecheck
```

The tests use Node's own test runner (Node 22.18 or later runs the `.ts` files as they are).

## Deploy it

```sh
sproutboat login
sproutboat deploy                    # prints https://realtime-room.<team>.sproutboat.app
```

Before you put it in front of people, add what a public room needs: a rate limit per connection and per address (see the `ratelimit` example and the chat room in Sproutboat's own `kitchen-sink`), and a login so a name means someone.

## Moving to Wrangler

The config is `sproutboat.jsonc` today. It uses only keys that exist in a `wrangler.jsonc` with the same meaning (`name`, `main`, `compatibility_date`, `durable_objects`), and nothing in `src/` is Sproutboat-specific, so converting is mechanical: `durable_objects` becomes a `bindings` list plus a `migrations` entry (`new_sqlite_classes: ["Room"]`). Sproutboat is making `wrangler.jsonc` a native config; `sproutboat migrate` will then do the conversion for you.
