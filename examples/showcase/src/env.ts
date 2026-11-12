/** The bindings declared in sproutboat.jsonc and wrangler.jsonc (one list for both). */
export interface Env {
  DB: D1Database;
  TICKETS: DurableObjectNamespace;
  BENCH: DurableObjectNamespace;
  /** Starts of a race, a timing run or a sale: a few a minute per address. */
  RUNS: RateLimit;
  /** One purchase in the "separate requests" race: a few hundred a minute per address. */
  BUYS: RateLimit;
  ASSETS: Fetcher;
  /** "cloud", "standalone" or "cloudflare": where this build was configured to run. */
  EDITION: string;
  /** Optional: the sleeping app the cold-start card wakes, and the Cloud endpoint for fleet numbers. */
  SLEEPER_URL?: string;
  DENSITY_URL?: string;
  /** Optional: this same worker deployed on Cloudflare, so the page can run the race there too. */
  COMPARE_URL?: string;
}
