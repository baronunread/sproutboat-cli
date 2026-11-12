// A very small app that is allowed to go to sleep. The showcase page wakes it from your browser and times it.
const startedAt = Date.now();
let served = 0;

interface Env {
  ASSETS: Fetcher;
}

// #region sleeper
// The first request this process serves is the one that woke it: the process was started to answer it.
// The static file next to this handler (ready.txt) is served by the edge without starting the app,
// so a browser can open its connection first and then time only the wake.
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ping") return env.ASSETS.fetch(request);
    const cold = served === 0;
    served++;
    return Response.json(
      { cold, served, startedAt, sinceStartMs: Date.now() - startedAt, now: Date.now() },
      {
        headers: {
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "timing-allow-origin": "*",
        },
      },
    );
  },
} satisfies ExportedHandler<Env>;
// #endregion
