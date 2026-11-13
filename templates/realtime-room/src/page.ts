// The page at "/": a room name, a nickname and a message box. Plain DOM, no build step.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Realtime room</title>
<style>
  body { font: 16px/1.4 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  form { display: flex; gap: .5rem; margin: .5rem 0; }
  input { flex: 1; padding: .4rem; font: inherit; }
  button { padding: .4rem .8rem; font: inherit; }
  #log { border: 1px solid #8884; border-radius: 6px; height: 50vh; overflow-y: auto; padding: .5rem; }
  #log p { margin: .2rem 0; }
  .note { color: #888; }
</style>
</head>
<body>
<h1>Realtime room</h1>
<form id="join">
  <input id="room" value="lobby" aria-label="Room" pattern="[a-z0-9][a-z0-9-]*" required>
  <input id="name" placeholder="Your name" aria-label="Your name" required>
  <button>Join</button>
</form>
<div id="log" role="log" aria-live="polite"></div>
<form id="say" hidden>
  <input id="text" placeholder="Say something" aria-label="Message" autocomplete="off" maxlength="500" required>
  <button>Send</button>
</form>
<script>
  const $ = (id) => document.getElementById(id);
  let socket;
  let keepAlive;
  function show(text, note) {
    const line = document.createElement("p");
    line.textContent = text;
    if (note) line.className = "note";
    $("log").append(line);
    $("log").scrollTop = $("log").scrollHeight;
  }
  $("join").addEventListener("submit", (event) => {
    event.preventDefault();
    if (socket) socket.close();
    const url = new URL("/rooms/" + $("room").value, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("name", $("name").value);
    socket = new WebSocket(url);
    socket.onopen = () => {
      $("say").hidden = false;
      // The runtime answers "ping" with "pong" itself, which keeps idle connections open through proxies.
      keepAlive = setInterval(() => socket.send("ping"), 30000);
    };
    socket.onclose = () => {
      clearInterval(keepAlive);
      $("say").hidden = true;
      show("disconnected", true);
    };
    socket.onmessage = ({ data }) => {
      if (data === "pong") return;
      const frame = JSON.parse(data);
      if (frame.type === "welcome") {
        $("log").replaceChildren();
        for (const message of frame.history) show(message.from + ": " + message.text);
        show("here: " + frame.presence.join(", "), true);
      } else if (frame.type === "message") show(frame.from + ": " + frame.text);
      else if (frame.type === "join") show(frame.name + " joined", true);
      else if (frame.type === "leave") show(frame.name + " left", true);
      else if (frame.type === "error") show(frame.error, true);
    };
  });
  $("say").addEventListener("submit", (event) => {
    event.preventDefault();
    socket.send(JSON.stringify({ type: "chat", text: $("text").value }));
    $("text").value = "";
  });
</script>
</body>
</html>
`;
