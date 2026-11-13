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
    // The page is mounted under a path on the main site (sproutboat.com/demo), so its routes may arrive with
    // that prefix. The page itself only ever asks for relative URLs.
    const path = url.pathname.replace(/^\/demo(?=\/)/, "");
    if (path === "/healthz") return json({ ok: true });
    if (path === "/api/info" && request.method === "GET") return json(info(env));
    if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
