/**
 * Version skew between a CLI and a control plane.
 *
 * The two update independently — the CLI from npm, a self-hosted node from its
 * own `SB_REF` — so a user can easily point a months-old CLI at a fresh box or
 * the reverse. Without a handshake that shows up as a 400 from a route that
 * moved, which tells them nothing.
 *
 * The exchange is response-only: every `/api/` response carries the control
 * plane's version and the oldest CLI it supports, and the CLI checks those on
 * responses it was already reading. Nothing is added to requests, so an old
 * control plane simply sends no headers and nothing happens.
 */
import { isNewer } from "./update-check";

export const CONTROL_VERSION_HEADER = "x-sproutboat-control";
export const MIN_CLI_HEADER = "x-sproutboat-min-cli";

/**
 * The warning to print for this response, or null when the pair is fine.
 * Pure so it can be tested without a server; `main.ts` prints what it returns.
 */
export function controlVersionWarning(response: Response, cliVersion: string): string | null {
  const min = response.headers.get(MIN_CLI_HEADER);
  // No header: a control plane older than this handshake. Nothing to say.
  if (!min || !isNewer(min, cliVersion)) return null;
  const control = response.headers.get(CONTROL_VERSION_HEADER);
  return (
    `this control plane${control ? ` (${control})` : ""} needs sproutboat ${min} or newer, ` +
    `and you are on ${cliVersion} — upgrade with \`bun add -g sproutboat@latest\``
  );
}
