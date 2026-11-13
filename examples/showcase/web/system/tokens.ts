/**
 * The showcase's own tokens, on top of ikada's. One typed source: `build-web.ts` writes them out as CSS custom
 * properties (web/tokens.generated.css) and the canvas scenes read the same objects, so a colour on a canvas and
 * the same colour in the DOM cannot drift apart.
 *
 * Colour has a meaning here and only one: green is a process that is running right now. Nothing decorative is green.
 */
export type Oklch = readonly [lightness: number, chroma: number, hue: number];

export const color = {
  /** The page ground: deeper than ikada's dashboard canvas, so light reads as light. */
  ink: [0.13, 0.012, 255],
  /** Below the waterline. */
  deep: [0.105, 0.014, 255],
  /** A raised strip: the nav, a readout. */
  shelf: [0.17, 0.014, 255],
  /** An app that is asleep: present, unlit. */
  asleep: [0.47, 0.022, 255],
  /** An app that is running: the brand green, #5BD97A. */
  alive: [0.795, 0.168, 149.5],
  /** The hot centre of a running app. */
  aliveCore: [0.94, 0.09, 150],
  /** A request the platform refused (a cap or a rate limit): amber, never red. */
  refused: [0.8, 0.14, 80],
  /** Quiet lines: the waterline, rules, rings. */
  line: [0.95, 0.01, 255],
} as const satisfies Record<string, Oklch>;

export const css = (value: Oklch, alpha = 1): string =>
  `oklch(${value[0]} ${value[1]} ${value[2]}${alpha < 1 ? ` / ${alpha}` : ""})`;

/**
 * The motion language. Four verbs, each tied to something that happened; nothing else on the page moves.
 *
 *   wake    a process started.        Fast, a spring that overshoots once.
 *   settle  a process stopped.        Slow and plain: sleep is not an event to celebrate.
 *   ripple  one request was answered. One ring per request, always, and never without one.
 *   level   a measured number moved.  Eases to the new sample and never overshoots: data does not bounce.
 */
export const motion = {
  wake: { stiffness: 320, damping: 17 },
  settleMs: 700,
  rippleMs: 760,
  levelMs: 420,
  /** Between lines of a staged entrance, and between the requests of a wave. */
  staggerMs: 70,
  waveStaggerMs: 14,
  entranceMs: 820,
  easeOut: "cubic-bezier(0.23, 1, 0.32, 1)",
} as const;

/** What build-web.ts writes into tokens.generated.css. */
export function tokensCss(): string {
  const lines = Object.entries(color).map(
    ([name, value]) => `  --stage-${name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}: ${css(value)};`,
  );
  lines.push(
    `  --stage-ease-out: ${motion.easeOut};`,
    `  --stage-entrance: ${motion.entranceMs}ms;`,
    `  --stage-stagger: ${motion.staggerMs}ms;`,
    `  --stage-level: ${motion.levelMs}ms;`,
  );
  return `/* Generated from web/system/tokens.ts by build-web.ts. Do not edit. */\n:root {\n${lines.join("\n")}\n}\n`;
}
