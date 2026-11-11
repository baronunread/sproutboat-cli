/**
 * Which endpoint and which stored profile a command talks to. One pure function, so the precedence is written down
 * once and tested:
 *
 *   1. `--api-url` and `--profile`, the flags. Both given must agree.
 *   2. `SPROUTBOAT_API_URL` and `SPROUTBOAT_PROFILE`, the environment. Both set must agree. A flag beats the other
 *      kind of variable: `--profile` beats `SPROUTBOAT_API_URL`, and `--api-url` beats `SPROUTBOAT_PROFILE`.
 *   3. The machine's active profile.
 *   4. The default endpoint.
 *
 * A profile fixes its endpoint, so a profile named next to a different URL is an error, never a quiet pick. That
 * is the mistake this exists to stop: a stored Community login deploying to Community when the Cloud was meant.
 */
import { PROFILE_NAME } from "./credentials";

export type ProfileSource = "--profile" | "SPROUTBOAT_PROFILE" | "active profile";
export type UrlSource = "--api-url" | "SPROUTBOAT_API_URL" | "profile" | "default";

export type Target = {
  apiUrl: string;
  source: UrlSource;
  /** The profile selected by name, or the active one used for lack of anything else. Unset when the URL decided. */
  profile?: { name: string; source: ProfileSource; exists: boolean };
};

export type TargetInput = {
  flagUrl?: string;
  flagProfile?: string;
  envUrl?: string;
  envProfile?: string;
  /** Stored profiles by name, with their endpoints. */
  profiles: Readonly<Record<string, { apiUrl: string }>>;
  activeProfile?: string;
  defaultUrl: string;
  /** `login` may name a profile that does not exist yet; it is made on save. */
  allowNew?: boolean;
};

export class TargetError extends Error {}

const trim = (url: string) => url.replace(/\/$/, "");

export function chooseTarget(input: TargetInput): Target {
  const flagUrl = input.flagUrl ? trim(input.flagUrl) : undefined;
  const envUrl = input.envUrl ? trim(input.envUrl) : undefined;

  const named = (
    name: string,
    source: "--profile" | "SPROUTBOAT_PROFILE",
    otherUrl?: string,
    otherSource?: "--api-url" | "SPROUTBOAT_API_URL",
    newUrl?: string,
  ) => {
    if (!PROFILE_NAME.test(name))
      throw new TargetError(`${source} "${name}" is not a profile name (letters, digits, . _ -; at most 64)`);
    const stored = input.profiles[name];
    if (stored === undefined) {
      if (!input.allowNew) {
        const known = Object.keys(input.profiles);
        throw new TargetError(
          `no profile named "${name}"${known.length > 0 ? ` (profiles: ${known.join(", ")})` : ""}; create it with \`sproutboat login --profile ${name}\``,
        );
      }
      const apiUrl = otherUrl ?? newUrl ?? trim(input.defaultUrl);
      return {
        apiUrl,
        source:
          otherUrl !== undefined && otherSource ? otherSource : newUrl !== undefined ? "SPROUTBOAT_API_URL" : "default",
        profile: { name, source, exists: false },
      } satisfies Target;
    }
    const apiUrl = trim(stored.apiUrl);
    if (otherUrl !== undefined && otherUrl !== apiUrl)
      throw new TargetError(
        `the profile "${name}" is for ${apiUrl}, but ${otherSource} says ${otherUrl}; drop one of them`,
      );
    return { apiUrl, source: "profile", profile: { name, source, exists: true } } satisfies Target;
  };

  if (input.flagProfile !== undefined) return named(input.flagProfile, "--profile", flagUrl, "--api-url", envUrl);
  if (flagUrl !== undefined) return { apiUrl: flagUrl, source: "--api-url" };
  if (input.envProfile !== undefined) {
    // The environment names a profile and also a URL: they must be the same place.
    return named(input.envProfile, "SPROUTBOAT_PROFILE", envUrl, "SPROUTBOAT_API_URL");
  }
  if (envUrl !== undefined) return { apiUrl: envUrl, source: "SPROUTBOAT_API_URL" };
  const active = input.activeProfile;
  if (active !== undefined && input.profiles[active])
    return {
      apiUrl: trim(input.profiles[active].apiUrl),
      source: "profile",
      profile: { name: active, source: "active profile", exists: true },
    };
  return { apiUrl: trim(input.defaultUrl), source: "default" };
}
