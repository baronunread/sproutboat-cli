/**
 * The comparison. Two tables because the platforms answer two different questions, every figure with its kind
 * (the platform's own, ours, or not published) and its source, and a column for what the other platform gives
 * that Sproutboat does not. The data is data/comparison.json; a test checks every cell is sourced.
 */
import comparison from "../../data/comparison.json";
import { Eyebrow } from "../system/act";

type Cell = { value: string; kind: string; by?: string; url?: string; more?: string };
/** One row's cell for a column. The JSON's rows have different keys per table, so it is looked up, not indexed. */
const cellOf = (cells: Record<string, Cell>, key: string): Cell | undefined =>
  Object.entries(cells).find(([name]) => name === key)?.[1];

const readOn = new Date(comparison.readOn + "T12:00:00Z").toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const host = (url: string) => new URL(url).hostname.replace(/^www\./, "");
const gib = (mib: number) => `${(mib / 1024).toFixed(mib < 10240 ? 2 : 1)} GiB`;

const { fleet } = comparison;
/** The memory of a thousand idle apps, and the line they have to fit under: the host this page's fleet runs on. */
export const FLEET_COMPARED = fleet.rows.map((row) => ({ ...row, totalMiB: row.perAppMiB * fleet.apps }));
const widest = Math.max(...FLEET_COMPARED.map((row) => row.totalMiB));

function Source({ cell }: { cell: Cell }) {
  return (
    <p className="mt-1.5 text-[0.8125rem] leading-[1.45] text-fg-muted text-pretty">
      {cell.kind === "measured" ? <span className="label me-2 text-fg-muted">Measured by us</span> : null}
      {cell.by}
      {cell.url ? (
        <>
          {cell.by ? " " : ""}
          <a
            className="link num text-[0.75rem] [overflow-wrap:anywhere]"
            href={cell.url}
            target="_blank"
            rel="noreferrer"
          >
            {host(cell.url)}
          </a>
        </>
      ) : null}
      {cell.more ? (
        <>
          {", "}
          <a
            className="link num text-[0.75rem] [overflow-wrap:anywhere]"
            href={cell.more}
            target="_blank"
            rel="noreferrer"
          >
            {host(cell.more)}
          </a>
        </>
      ) : null}
    </p>
  );
}

function Group({ group }: { group: (typeof comparison.groups)[number] }) {
  return (
    <div className="mt-[clamp(3rem,8svh,5rem)]">
      <h3 className="text-sb-xl font-semibold tracking-[-0.02em]">{group.title}</h3>
      <p className="mt-2 max-w-[44rem] text-sb-base text-fg-muted text-pretty">{group.question}</p>
      <table className="mt-6 w-full border-collapse text-start max-lg:block lg:table-fixed">
        <thead className="max-lg:sr-only">
          <tr className="border-b border-stage-line/10">
            <th scope="col" className="label w-[13%] py-3 pe-6 text-start font-medium">
              Platform
            </th>
            {group.columns.map((column) => (
              <th key={column.key} scope="col" className="label py-3 pe-6 text-start font-medium">
                {column.label}
              </th>
            ))}
            <th scope="col" className="label w-[24%] py-3 text-start font-medium">
              What it gives that we do not
            </th>
          </tr>
        </thead>
        <tbody className="max-lg:block">
          {group.rows.map((row) => (
            <tr
              key={row.name}
              className="border-b border-stage-line/10 align-top max-lg:grid max-lg:grid-cols-2 max-lg:gap-x-6 max-lg:py-6"
            >
              <th
                scope="row"
                className="py-5 pe-6 text-start text-sb-base font-semibold text-fg max-lg:col-span-2 max-lg:py-0 max-lg:text-sb-lg"
              >
                {row.name}
              </th>
              {group.columns.map((column) => {
                const cell = cellOf(row.cells, column.key);
                if (!cell) return <td key={column.key} />;
                return (
                  <td key={column.key} className="py-5 pe-6 max-lg:block max-lg:py-0 max-lg:pt-4 max-lg:pe-0">
                    <p className="label mb-1.5 lg:hidden">{column.label}</p>
                    <p
                      className={`text-sb-base text-pretty ${cell.kind === "unpublished" ? "text-fg-muted" : "text-fg"} ${column.key === "runs" ? "" : "num"}`}
                    >
                      {cell.value}
                    </p>
                    <Source cell={cell} />
                  </td>
                );
              })}
              <td className="py-5 text-sb-base text-fg-muted text-pretty max-lg:col-span-2 max-lg:block max-lg:py-0 max-lg:pt-4">
                <p className="label mb-1.5 lg:hidden">
                  {row.ours ? "What we do not give" : "What it gives that we do not"}
                </p>
                {row.gives}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Compared() {
  return (
    <section id="compared" className="scroll-mt-(--nav-h) border-t border-stage-line/8 bg-stage-deep">
      <div className="wrap py-[clamp(4rem,12svh,8rem)]">
        <Eyebrow number="04">Compared</Eyebrow>
        <h2 className="mt-5 max-w-[20ch] text-title text-balance">The same thousand apps, somewhere else.</h2>
        <p className="mt-5 max-w-[42rem] text-lede text-fg-muted text-pretty">
          Every figure below is the platform's own published one, or says it was measured by us and on what. Where we
          found none, it says so. Read on {readOn}.
        </p>

        <figure className="mt-[clamp(2.5rem,7svh,4rem)]">
          <figcaption className="label">
            {fleet.apps.toLocaleString("en")} idle apps, held in memory on one server
          </figcaption>
          <div className="relative mt-5 md:pb-9">
            {FLEET_COMPARED.map((row) => (
              <div
                key={row.name}
                className="grid gap-x-6 gap-y-1.5 py-3 md:grid-cols-[13rem_minmax(0,1fr)] md:items-center"
              >
                <p className="text-sb-base font-semibold text-fg">{row.name}</p>
                <div className="flex items-center gap-3">
                  <span
                    className={`h-2.5 shrink-0 rounded-[1px] ${row.ours ? "bg-stage-line" : "bg-stage-asleep"}`}
                    style={{ width: `max(3px, ${((row.totalMiB / widest) * 76).toFixed(2)}%)` }}
                  />
                  <span className="num text-sb-base whitespace-nowrap text-fg">{gib(row.totalMiB)}</span>
                </div>
              </div>
            ))}
            {/* The line: the memory of the host this page's fleet runs on. One bar ends before it. */}
            <div className="pointer-events-none absolute inset-y-0 start-[14.5rem] end-0 hidden md:block">
              <div
                className="absolute inset-y-0 border-s border-dashed border-stage-line/45"
                style={{ insetInlineStart: `${((fleet.hostMiB / widest) * 76).toFixed(2)}%` }}
              >
                <p className="num absolute bottom-0 start-2 text-[0.75rem] whitespace-nowrap text-fg-muted">
                  {gib(fleet.hostMiB)}: the server this page’s fleet runs on
                </p>
              </div>
            </div>
          </div>
          <p className="num mt-2 text-[0.75rem] text-fg-muted md:hidden">
            The server this page’s fleet runs on has {gib(fleet.hostMiB)}.
          </p>
          <p className="mt-4 max-w-[52rem] text-[0.8125rem] leading-[1.45] text-fg-muted text-pretty">
            <span className="label me-2">Measured by us</span>
            {FLEET_COMPARED.map((row) => `${row.name}: ${row.perAppMiB} MiB each (${row.by}).`).join(" ")}
          </p>
        </figure>

        {comparison.groups.map((group) => (
          <Group key={group.id} group={group} />
        ))}
      </div>
    </section>
  );
}
