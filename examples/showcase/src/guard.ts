/** Shared by every section's routes: the visitor's address, JSON replies, rate limits, clamped numbers. */

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80)/i;

/** The visitor's address: Cloudflare's own header where there is one, the peer (or the proxy's last hop) elsewhere. */
export function clientKey(request: Request): string {
  const cloudflare = request.headers.get("cf-connecting-ip");
  if (cloudflare) return cloudflare;
  // Sproutboat puts the peer address in request.cf.clientIp (docs/standalone.md); its types do not list it yet.
  const peer = (request as Request & { cf?: { clientIp?: string } }).cf?.clientIp ?? "";
  if (peer && !PRIVATE.test(peer)) return peer;
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",");
  return hops[hops.length - 1]?.trim() || "shared";
}

export function json<Body extends object>(body: Body, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** null when the call may go ahead, else the 429 to send back. */
export async function allow(limiter: RateLimit, request: Request): Promise<Response | null> {
  const verdict = await limiter.limit({ key: clientKey(request) });
  if (verdict.success) return null;
  return json({ error: "slow down: too many requests from your address", code: "rate_limited" }, 429, {
    "retry-after": "10",
  });
}

/** An integer from the query string, clamped to [min, max]; the fallback when it is missing or not a number. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = Number(url.searchParams.get(name));
  if (!url.searchParams.has(name) || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}
