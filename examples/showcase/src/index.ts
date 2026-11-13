// The showcase page's own app. The page is static files (site/, served by the edge without starting this
// process); this handler only tells the page where it is running and where each section's live data is.
// Sections B, C and D add their routes here: see DESIGN.md, "Spec for the builder".
import { json } from "./guard";

// #region info
// The page asks once where its live data comes from. An empty URL means "not available where this copy
// runs", and the section then shows its dated benchmark with a label instead of a live feed.
function info(env: Env) {
  return {
    edition: env.EDITION,
    fleet:
      env.FLEET_STATE_URL && env.FLEET_APP_URL ? { stateUrl: env.FLEET_STATE_URL, appUrl: env.FLEET_APP_URL } : null,
  };
}
// #endregion

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/api/info" && request.method === "GET") return json(info(env));
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
