// Stress harness: one request drives many binding operations, so the numbers
// reflect the binding rather than HTTP overhead.
export class Bag {
  constructor(state) {
    this.state = state;
  }
  fetch(request) {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get("n") || 100);
    if (url.pathname === "/write") {
      for (let i = 0; i < n; i++) this.state.storage.put("k" + i, "v".repeat(256));
      return new Response("ok");
    }
    if (url.pathname === "/list") {
      const all = this.state.storage.list({ prefix: "" });
      return new Response(String(all.size || 0));
    }
    if (url.pathname === "/alarm") {
      this.state.storage.setAlarm(Date.now() + 500);
      return new Response("armed");
    }
    return new Response("ok");
  }
  alarm() {
    this.state.storage.put("fired", (this.state.storage.get("fired") || 0) + 1);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const n = Number(url.searchParams.get("n") || 1000);
    const size = Number(url.searchParams.get("size") || 1024);
    const blob = "x".repeat(size);

    if (p === "/kv/write") {
      for (let i = 0; i < n; i++) env.CACHE.put("k" + i, blob);
      return new Response("wrote " + n);
    }
    if (p === "/kv/list") return new Response(String(env.CACHE.list("").length));

    if (p === "/d1/write") {
      env.DB.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
      for (let i = 0; i < n; i++) env.DB.prepare("INSERT INTO t (v) VALUES (?)").bind(blob).run();
      return new Response("inserted " + n);
    }
    if (p === "/d1/read") return new Response(String(env.DB.prepare("SELECT id, v FROM t").all().results.length));

    if (p === "/r2/write") {
      for (let i = 0; i < n; i++) env.UP.put("o" + i, blob);
      return new Response("stored " + n);
    }
    // Stores the request body itself, so concurrency is measured with the body
    // actually retained rather than discarded.
    if (p === "/r2/upload") {
      const body = request.body || "";
      const key = "u" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      env.UP.put(key, body);
      return new Response("stored " + body.length);
    }
    if (p === "/r2/list") return new Response(String((env.UP.list({ prefix: "" }).objects || []).length));

    if (p === "/queue/send") {
      for (let i = 0; i < n; i++) env.JOBS.send(JSON.stringify({ i, blob }));
      return new Response("queued " + n);
    }
    if (p === "/ae/write") {
      for (let i = 0; i < n; i++) env.METRICS.writeDataPoint({ blobs: ["b", blob], doubles: [i] });
      return new Response("points " + n);
    }
    if (p === "/ae/query") return new Response(String((env.METRICS.query({ limit: 200 }).rows || []).length));

    if (p === "/do/write" || p === "/do/list" || p === "/do/alarm") {
      const stub = env.BAG.get(env.BAG.idFromName("one"));
      return stub.fetch(new Request("https://do" + p.replace("/do", "") + "?n=" + n));
    }

    // The interesting one: an allowlisted upstream that returns a lot.
    if (p === "/fetch") {
      const target = url.searchParams.get("u");
      try {
        const res = await fetch(target);
        const body = await res.text();
        return new Response("fetched " + body.length + " bytes");
      } catch (e) {
        return new Response("threw: " + (e && e.message), { status: 502 });
      }
    }

    if (p === "/assets") {
      const res = env.ASSETS.fetch(new Request("https://x/index.html"));
      return new Response("asset " + res.status);
    }

    return new Response("ok");
  },
  queue(batch) {
    batch.ackAll();
  },
};
