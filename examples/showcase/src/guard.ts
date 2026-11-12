/** Hard caps. Every experiment is bounded so a 32 MiB app can serve it. */
export const LIMITS = { maxFans: 500, maxSeats: 200, maxSeparate: 60, maxOpenSales: 8, saleTtlMs: 120_000 };

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80)/i;

/** workerd names itself in navigator.userAgent; Sproutboat has no navigator. */
export const onWorkerd = (): boolean => globalThis.navigator?.userAgent === "Cloudflare-Workers";

/** The visitor's address: Cloudflare's own header there, the peer (or the proxy's last hop) elsewhere. */
export function clientKey(request: Request): string {
  if (onWorkerd()) return request.headers.get("cf-connecting-ip") ?? "unknown";
  // SAFETY: Sproutboat puts the peer address in request.cf.clientIp; a runtime without it leaves it undefined.
  const peer = (request.cf as { clientIp?: string } | undefined)?.clientIp ?? "";
  if (peer && !PRIVATE.test(peer)) return peer;
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",");
  return hops[hops.length - 1]?.trim() || "shared";
}

export function json<Body extends object>(body: Body, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}

/** null when the call may go ahead, else the 429 to send back. */
export async function allow(limiter: RateLimit, request: Request): Promise<Response | null> {
  const verdict = await limiter.limit({ key: clientKey(request) });
  if (verdict.success) return null;
  return json({ error: "slow down: too many runs from your address", code: "rate_limited" }, 429, {
    "retry-after": "10",
  });
}

/** An integer from the query string, clamped to [min, max]; the fallback when it is missing or not a number. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = Number(url.searchParams.get(name));
  if (!url.searchParams.has(name) || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}
