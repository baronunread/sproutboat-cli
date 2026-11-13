import { ACTS } from "../system/chrome";

/**
 * Acts 02 and 03 are specified in DESIGN.md and not built yet, and two more are planned for after launch.
 * Until they exist the page says so in one place, and says which is which.
 */
const NEXT = [
  "This page is one file of about 6 MB. Download it, see what is inside it next to a Node.js container of the same app, and run it: the copy on your machine serves this page with no network at all.",
  "The whole platform on a small server of your own, from one command. An unedited terminal recording with its real timings, from a fresh machine to a deployed app.",
];

const LATER = [
  {
    name: "Is my Cloudflare project compatible?",
    text: "Point it at a wrangler.jsonc and get a straight answer, binding by binding.",
  },
  {
    name: "Deploy your own app into the fleet",
    text: "One command from your terminal, and a new dot appears in the grid above with your app behind it.",
  },
];

const ROW =
  "grid scroll-mt-(--nav-h) gap-x-12 gap-y-2 border-t border-stage-line/10 py-7 md:grid-cols-[minmax(0,5fr)_minmax(0,8fr)]";
const NAME = "flex items-baseline gap-4 text-sb-xl font-semibold tracking-[-0.02em]";
const TEXT = "max-w-[40rem] text-lede text-fg-muted text-pretty";

export function Upcoming() {
  return (
    <section className="border-t border-stage-line/8">
      <div className="wrap py-[clamp(4rem,12svh,8rem)]">
        <p className="label">Next on this page</p>
        <ol className="mt-8 border-b border-stage-line/10">
          {ACTS.slice(1).map((act, index) => (
            <li key={act.id} id={act.id} className={ROW}>
              <h2 className={NAME}>
                <span className="num text-sb-sm font-medium text-fg-muted">{act.number}</span>
                {act.name}
              </h2>
              <p className={TEXT}>{NEXT[index]}</p>
            </li>
          ))}
        </ol>
        <p className="label mt-14">Later</p>
        <ul className="mt-8 border-b border-stage-line/10">
          {LATER.map((item) => (
            <li key={item.name} className={ROW}>
              <h2 className={`${NAME} text-fg-muted`}>{item.name}</h2>
              <p className={TEXT}>{item.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
