/**
 * Green/leaf terminal styling. Every helper is a no-op when stdout is not a TTY
 * or NO_COLOR is set (https://no-color.org), so piped/CI output stays plain.
 */
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint =
  (code: string) =>
  (text: string): string =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export const leaf = paint("32"); // green — headings, structure, the accent
export const sprout = paint("92"); // bright green — success
export const dim = paint("2"); // secondary detail
export const bold = paint("1");
export const amber = paint("33"); // warnings
export const rose = paint("31"); // errors

/** "✓ message" with a green tick. */
export const ok = (message: string): string => `${sprout("✓")} ${message}`;
/** "▸ message" with a green marker — section headers. */
export const step = (message: string): string => `${leaf("▸")} ${bold(message)}`;
