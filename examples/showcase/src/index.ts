import type { Env } from "./env";
import { LIMITS, allow, intParam, json, onWorkerd } from "./guard";
import { STRATEGIES, buy, closeSale, openSale, prune, runRace, type Strategy } from "./race";
import { compareQueries } from "./timing";

export { TicketOffice } from "./race";
export { QueryBench } from "./timing";

// workerd freezes the clock outside a request, so the first request sets it.
let firstRequestAt = 0;
let timingBusy = false;

function strategyOf(url: URL): Strategy | null {
  const wanted = url.searchParams.get("strategy");
  return STRATEGIES.find((strategy) => strategy === wanted) ?? null;
}

async function api(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  firstRequestAt ||= Date.now();
  if (route === "GET /api/info") {
    return json({
      edition: env.EDITION,
      runtime: onWorkerd() ? "workerd" : "sproutboat",
      firstRequestAt,
      limits: LIMITS,
      sleeperUrl: env.SLEEPER_URL || null,
      densityUrl: env.DENSITY_URL || null,
      compareUrl: env.COMPARE_URL || null,
    });
  }

  const strategy = strategyOf(url);
  if (route === "POST /api/race" && strategy) {
    const blocked = await allow(env.RUNS, request);
    if (blocked) return blocked;
    const fans = intParam(url, "fans", 300, 1, LIMITS.maxFans);
    const seats = intParam(url, "seats", 100, 1, LIMITS.maxSeats);
    const result = await runRace(env, strategy, fans, seats);
    ctx.waitUntil(prune(env));
    return result
      ? json(result)
      : json({ error: "too many races are running: try again in a moment", code: "busy" }, 503);
  }

  // The same sale, bought one HTTP request at a time (the browser sends the requests).
  if (route === "POST /api/sale" && strategy) {
    const blocked = await allow(env.RUNS, request);
    if (blocked) return blocked;
    const sale = await openSale(env, strategy, intParam(url, "seats", 20, 1, LIMITS.maxSeats));
    ctx.waitUntil(prune(env));
    return sale ? json({ sale }) : json({ error: "too many sales are open: try again in a moment", code: "busy" }, 503);
  }
  const sale = url.searchParams.get("sale") ?? "";
  if (route === "POST /api/buy" && strategy) {
    const blocked = await allow(env.BUYS, request);
    if (blocked) return blocked;
    return json({ seat: await buy(env, strategy, sale, intParam(url, "fan", 0, 0, LIMITS.maxSeparate - 1)) });
  }
  if (route === "POST /api/sale/close" && strategy) {
    const result = await closeSale(env, strategy, sale, intParam(url, "fans", 1, 1, LIMITS.maxSeparate));
    return result ? json(result) : json({ error: "unknown sale", code: "not_found" }, 404);
  }

  if (route === "POST /api/timings") {
    const blocked = await allow(env.RUNS, request);
    if (blocked) return blocked;
    if (timingBusy) return json({ error: "another timing run is in progress", code: "busy" }, 503);
    timingBusy = true;
    try {
      return json(await compareQueries(env));
    } finally {
      timingBusy = false;
    }
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true, at: Date.now() });
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, ctx, url);
    } catch (error) {
      // The cause stays in the log; a visitor gets no internals.
      console.log(`500 ${request.method} ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
