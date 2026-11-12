// The showcase page. Every number it prints comes from a request it just made, or from a file that
// names its source and date (build-info.json, benchmarks.json, compare-recorded.json, binaries.json).

const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "text") node.textContent = value;
    else if (key === "style") node.setAttribute("style", value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
};
const fmt = (n, digits = 0) =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function getJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, body });
  return body;
}
const post = (base, path) => getJson(base + path, { method: "POST" });

function readout(label, value, unit, tone) {
  const dd = el("dd", { class: "num" }, document.createTextNode(value));
  if (unit) dd.append(el("small", { text: unit }));
  return el("div", { class: "readout", "data-tone": tone }, el("dt", { text: label }), dd);
}
const setReadouts = (selector, items) => $(selector).replaceChildren(...items.map((item) => readout(...item)));

const [info, build] = await Promise.all([
  getJson("/api/info").catch(() => null),
  getJson("/build-info.json").catch(() => null),
]);

// ---------------------------------------------------------------- theme and header
$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("sb-theme", dark ? "dark" : "light");
  } catch {}
});

{
  const pill = $("#runtime");
  const where = {
    cloud: "Sproutboat Cloud",
    standalone: "a standalone Sproutboat binary",
    cloudflare: "Cloudflare workerd",
  };
  if (info) {
    pill.dataset.live = "true";
    pill.lastElementChild.textContent = `This page is served by ${where[info.edition] ?? info.runtime}`;
  } else {
    pill.lastElementChild.textContent = "The server did not answer: the experiments below need it";
  }
  if (build)
    $("#built").textContent =
      `Built ${new Date(build.builtAt).toUTCString()} · compatibility date ${build.compatibilityDate} · source ${build.sourceSha256.slice(0, 12)}`;
}

// ---------------------------------------------------------------- 1a. density
async function density() {
  const bench = build?.benchmarks?.density;
  const fleet = $("#fleet");
  const dots = (count) => {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) fragment.append(document.createElement("i"));
    fleet.replaceChildren(fragment);
  };
  if (info?.densityUrl) {
    try {
      const live = await getJson(info.densityUrl);
      dots(Math.min(1000, live.appsDeployed));
      $("#fleet-chip").textContent = "live";
      $("#fleet-chip").dataset.kind = "live";
      $("#fleet-caption").textContent =
        `One dot is one app (up to 1,000). Sampled ${Math.max(0, Math.round((Date.now() - live.sampledAt) / 1000))} s ago.`;
      setReadouts("#fleet-readouts", [
        ["Apps deployed", fmt(live.appsDeployed)],
        ["Apps running now", fmt(live.appsRunning)],
        ["Private memory per app", fmt(live.workerPrivateKiBMedian / 1024, 2), "MiB median"],
      ]);
      $("#fleet-note").textContent = "From the Cloud's public density endpoint: counts and one median, no app names.";
      return;
    } catch {
      // fall through to the benchmark, and say so
    }
  }
  if (!bench) return;
  dots(bench.apps);
  const pss = median(bench.idlePssKiB);
  $("#fleet-caption").textContent = "One dot is one app in the benchmark.";
  setReadouts("#fleet-readouts", [
    ["Apps on one host", fmt(bench.apps)],
    ["Host memory, idle", fmt(pss / 1024), "MiB"],
    ["Share of that, per app", fmt(pss / bench.apps / 1024, 2), "MiB"],
    ["Private to one app", fmt(bench.workerMedianKiB.privateDirty), "KiB median"],
  ]);
  $("#fleet-note").innerHTML = "";
  $("#fleet-note").append(
    el("b", { text: `Benchmark, ${bench.date}, not live. ` }),
    document.createTextNode(
      `${bench.source}. Limit: ${bench.limits}. ${bench.note} The Cloud has no public endpoint for live fleet numbers yet.`,
    ),
  );
}

// ---------------------------------------------------------------- 1b. wake a sleeping app
async function wakeSetup() {
  const button = $("#wake-btn");
  const note = $("#wake-note");
  const cold = build?.binaries?.cold;
  const coldItems = cold
    ? [
        ["Standalone binary, later starts", fmt(cold.laterMedianMs), "ms median"],
        ["The very first start", fmt(cold.firstMs), "ms"],
      ]
    : [];
  if (!info?.sleeperUrl) {
    button.disabled = true;
    $("#wake").replaceChildren(
      el("div", {
        class: "wake-empty",
        text: "The sleeping app is not connected in this deployment, so there is nothing to wake.",
      }),
    );
    setReadouts("#wake-readouts", coldItems);
    note.textContent = cold
      ? `Measured when this page was built: ${cold.runs.length} starts of the standalone binary on ${cold.host}, ${cold.date}. ${cold.note}`
      : "Set SLEEPER_URL to the address of a deployed showcase-sleeper to wake it from here.";
    return;
  }
  const base = info.sleeperUrl.replace(/\/$/, "");
  setReadouts("#wake-readouts", [["Waiting for a request", "—"]]);
  note.textContent =
    "The app is stopped when nobody has called it for a while. Your browser first fetches a static file from the same host, which does not start the app, and then times a request that does.";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const rows = [];
      const add = (label, kind) => {
        const fill = el("span", { class: "fill" });
        const out = el("output", { text: "…" });
        $("#wake").append(
          el(
            "div",
            { class: "bar-row", "data-kind": kind },
            el("span", { text: label }),
            el("span", { class: "track" }, fill),
            out,
          ),
        );
        rows.push({ fill, out });
        return rows[rows.length - 1];
      };
      $("#wake").replaceChildren();
      await fetch(`${base}/ready.txt`, { mode: "no-cors", cache: "no-store" });
      const times = [];
      let first = null;
      for (let i = 0; i < 6; i++) {
        const row = add(i === 0 ? "first" : `#${i + 1}`, i === 0 ? "cold" : "warm");
        const started = performance.now();
        const answer = await getJson(`${base}/ping?n=${Date.now()}-${i}`, { cache: "no-store" });
        const ms = performance.now() - started;
        times.push(ms);
        if (i === 0) first = answer;
        row.out.textContent = `${fmt(ms, 1)} ms`;
        const max = Math.max(...times);
        rows.forEach((r, index) => (r.fill.style.width = `${Math.max(2, (times[index] / max) * 100)}%`));
      }
      const warm = median(times.slice(1));
      const asleep = first.cold;
      setReadouts("#wake-readouts", [
        [asleep ? "Wake-up request" : "First request", fmt(times[0], 1), "ms"],
        ["Warm, median of 5", fmt(warm, 1), "ms", "good"],
        ["App code ran before your request", fmt(first.sinceStartMs), "ms"],
        ["Process had served", `${fmt(first.served - 1)} earlier`, ""],
      ]);
      note.textContent = asleep
        ? "That first request found the app stopped: the process was started to answer it. Times are what your browser saw, so they include your network to the host."
        : "That app was already running (someone woke it a moment ago), so the first request was warm. Try again in a few minutes.";
    } catch (error) {
      note.textContent = `The sleeping app did not answer (${error.message}).`;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- 2. the race
const LANES = [
  { key: "naive", title: "Read, then write", tag: "D1" },
  { key: "statement", title: "One statement", tag: "D1" },
  { key: "object", title: "Durable Object", tag: "object SQLite" },
];
const SIZES = {
  in: { seats: 100, label: "inside one request" },
  sep: { seats: 20, fans: 40, label: "as 40 separate requests" },
};
let mode = "in";
let racing = false;

function lane(item) {
  const seats = el("div", { class: "seats", role: "img", "aria-label": `Seat map for ${item.title}` });
  const root = el(
    "div",
    { class: "lane", "data-lane": item.key },
    el("h4", {}, document.createTextNode(item.title), el("span", { text: item.tag })),
    el("div", { class: "state", text: "Waiting" }),
    seats,
    el("div", { class: "meter" }, el("b"), el("b")),
    el("dl", {}),
  );
  return root;
}
const lanes = $("#lanes");
lanes.replaceChildren(...LANES.map(lane));
const laneOf = (key) => $(`[data-lane="${key}"]`, lanes);

function resetLane(item, seats) {
  const root = laneOf(item.key);
  $(".state", root).textContent = "Waiting";
  $(".seats", root).replaceChildren(...Array.from({ length: seats }, () => el("i")));
  const [ok, over] = root.querySelectorAll(".meter b");
  ok.style.width = over.style.width = "0";
  $("dl", root).replaceChildren();
}

function paintLane(item, result, extra) {
  const root = laneOf(item.key);
  const cells = $(".seats", root);
  cells.replaceChildren(
    ...result.tally.map((n, index) => {
      const cell = el("i", { title: `Seat ${index + 1}: ${n} ticket${n === 1 ? "" : "s"}` });
      if (n === 1) cell.dataset.n = "1";
      if (n > 1) {
        cell.dataset.multi = "";
        cell.textContent = n > 999 ? "999+" : String(n);
      }
      return cell;
    }),
  );
  const total = Math.max(result.ticketsIssued, result.seats);
  const [ok, over] = root.querySelectorAll(".meter b");
  const okShare = (Math.min(result.ticketsIssued, result.seats) / total) * 100;
  ok.style.width = `${okShare}%`;
  over.style.insetInlineStart = `${okShare}%`;
  over.style.width = `${100 - okShare}%`;
  const bad = result.ticketsIssued > result.seats;
  const rows = [
    [`Tickets for ${result.seats} seats`, fmt(result.ticketsIssued), bad ? "bad" : "good"],
    ["Seats given to 2 or more fans", fmt(result.seatsDoubleBooked), result.seatsDoubleBooked ? "bad" : "good"],
    ["Counter says sold", fmt(result.counterSold), result.counterSold === result.ticketsIssued ? undefined : "bad"],
    ["Turned away", fmt(result.turnedAway)],
  ];
  if (extra?.elapsedMs != null) rows.push(["Time for the race", `${fmt(extra.elapsedMs)} ms`]);
  $("dl", root).replaceChildren(
    ...rows.flatMap(([label, value, tone]) => [
      el("dt", { text: label }),
      el("dd", { text: value, "data-tone": tone }),
    ]),
  );
  $(".state", root).textContent = bad ? "More tickets than seats" : "Every seat sold once";
}

/** One race for one strategy against `base`: `fans` of them inside one request, or the fixed 40 separate requests. */
async function race(base, key, how, fans = 300) {
  if (how === "in") return post(base, `/api/race?strategy=${key}&fans=${fans}&seats=${SIZES.in.seats}`);
  const { sale } = await post(base, `/api/sale?strategy=${key}&seats=${SIZES.sep.seats}`);
  await Promise.all(
    Array.from({ length: SIZES.sep.fans }, (_, fan) => post(base, `/api/buy?strategy=${key}&sale=${sale}&fan=${fan}`)),
  );
  return post(base, `/api/sale/close?strategy=${key}&sale=${sale}&fans=${SIZES.sep.fans}`);
}

const verdict = $("#verdict");
function say(text, tone) {
  verdict.textContent = text;
  if (tone) verdict.dataset.tone = tone;
  else delete verdict.dataset.tone;
}

function conclusion(results, how) {
  const naive = results.naive;
  const safe =
    results.statement.ticketsIssued <= results.statement.seats && results.object.ticketsIssued <= results.object.seats;
  if (naive.ticketsIssued > naive.seats) {
    return [
      `Read-then-write handed out ${fmt(naive.ticketsIssued)} tickets for ${naive.seats} seats and its own counter says only ${fmt(naive.counterSold)} sold. ${fmt(naive.seatsDoubleBooked)} seat${naive.seatsDoubleBooked === 1 ? "" : "s"} went to more than one fan. ${safe ? "One statement and the Durable Object sold each seat once." : "The other two also oversold: that is a bug to report."}`,
      "bad",
    ];
  }
  if (how === "sep") {
    return [
      `Read-then-write did not double-book here: ${naive.ticketsIssued} tickets for ${naive.seats} seats across ${SIZES.sep.fans} separate requests sent at once. This app runs one request's code at a time, so nothing could run between the read and the write. Overlap inside one request still races (switch back to “Inside one request”).`,
      "good",
    ];
  }
  return [
    `Read-then-write sold ${naive.ticketsIssued} tickets for ${naive.seats} seats this time: the fans did not overlap on this run.`,
    "warn",
  ];
}

async function runRace() {
  if (racing) return;
  racing = true;
  const button = $("#race-btn");
  button.disabled = true;
  const fans = Number($("#fans").value);
  const seats = mode === "in" ? SIZES.in.seats : SIZES.sep.seats;
  LANES.forEach((item) => resetLane(item, seats));
  say(`Running ${LANES.length} sales ${SIZES[mode].label}…`);
  const results = {};
  try {
    for (const item of LANES) {
      $(".state", laneOf(item.key)).textContent = "Running…";
      const result = await race("", item.key, mode, fans);
      results[item.key] = result;
      paintLane(item, result, result);
      lastRuns[mode][item.key] = result;
    }
    const [text, tone] = conclusion(results, mode);
    say(text, tone);
  } catch (error) {
    say(
      error.status === 429
        ? "That is a lot of runs from one address. Wait a few seconds and try again."
        : `The run stopped: ${error.message}`,
      "warn",
    );
    LANES.forEach((item) => {
      if (!results[item.key]) $(".state", laneOf(item.key)).textContent = "Stopped";
    });
  } finally {
    racing = false;
    button.disabled = false;
  }
}
const lastRuns = { in: {}, sep: {} };

function setMode(next) {
  if (racing) return;
  mode = next;
  lanes.dataset.mode = next;
  $("#mode-in").setAttribute("aria-pressed", String(next === "in"));
  $("#mode-sep").setAttribute("aria-pressed", String(next === "sep"));
  $("#fans-wrap").dataset.off = String(next === "sep");
  $("#fans").disabled = next === "sep";
  $("#fans-out").textContent = next === "sep" ? String(SIZES.sep.fans) : $("#fans").value;
  LANES.forEach((item) => resetLane(item, next === "in" ? SIZES.in.seats : SIZES.sep.seats));
  say(
    next === "in"
      ? "Press “Run the race”. Every fan starts a purchase before any has finished."
      : "Press “Run the race”. The browser sends 40 purchases as separate HTTP requests at once, for 20 seats.",
  );
}
$("#mode-in").addEventListener("click", () => setMode("in"));
$("#mode-sep").addEventListener("click", () => setMode("sep"));
$("#fans").addEventListener("input", (event) => ($("#fans-out").textContent = event.target.value));
$("#race-btn").addEventListener("click", runRace);
setMode("in");

// per-query timings
$("#q-btn").addEventListener("click", async () => {
  const button = $("#q-btn");
  button.disabled = true;
  try {
    const timing = await post("", "/api/timings");
    const max = Math.max(timing.d1.maxUs, timing.object.maxUs);
    for (const key of ["d1", "object"]) {
      const t = timing[key];
      $(`#q-${key}`).style.width = `${Math.max(1.5, (t.medianUs / max) * 100)}%`;
      $(`#q-${key}-out`).textContent = `${fmt(t.medianUs, t.medianUs < 10 ? 1 : 0)} µs`;
      const track = $(`#q-${key}`).parentElement;
      track.querySelectorAll("i").forEach((dot) => dot.remove());
      t.samplesUs.forEach((sample) => track.append(el("i", { style: `left:${(sample / max) * 100}%` })));
    }
    $("#q-note").textContent =
      `Median of eight batches (${fmt(timing.d1.batch)} queries per batch for D1, ${fmt(timing.object.batch)} for the object), each divided by its size. The clock ticks in whole milliseconds. Measured just now by ${info?.runtime === "workerd" ? "workerd" : "Sproutboat"}.`;
  } catch (error) {
    $("#q-note").textContent =
      error.status === 429 || error.status === 503
        ? "Busy: try again in a few seconds."
        : `Timing failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- 3. same code, two runtimes
const ROWS = [
  { key: "naive", label: "Read, then write" },
  { key: "statement", label: "One statement" },
  { key: "object", label: "Durable Object" },
];
function cell(result) {
  if (!result) return el("td", { text: "—" });
  const bad = result.ticketsIssued > result.seats;
  const text = bad
    ? `${fmt(result.ticketsIssued)} tickets, ${fmt(result.seats)} seats`
    : `${fmt(result.ticketsIssued)} of ${fmt(result.seats)} seats, once each`;
  return el("td", { text, "data-tone": bad ? "bad" : "good" });
}
function table(target, data) {
  target.replaceChildren(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { text: "Strategy" }),
        el("th", { text: "Inside one request" }),
        el("th", { text: "40 separate requests" }),
      ),
    ),
    el(
      "tbody",
      {},
      ...ROWS.map((row) =>
        el("tr", {}, el("td", { text: row.label }), cell(data?.in?.[row.key]), cell(data?.sep?.[row.key])),
      ),
    ),
  );
}
const fromReport = (report) => report && { in: report.inRequest, sep: report.separateRequests };

async function compare() {
  const recorded = build?.compare;
  const workerd = recorded?.runs?.workerd;
  let right = fromReport(workerd);
  if (info?.compareUrl) {
    $("#cf-cf-chip").textContent = "live";
    $("#cf-cf-chip").dataset.kind = "live";
    $("#cf-cf-sub").textContent = info.compareUrl;
    right = null;
  } else if (workerd) {
    $("#cf-cf-sub").textContent =
      `Recorded ${recorded.recordedAt.slice(0, 10)}: wrangler ${recorded.wrangler}, run locally on ${recorded.host}.`;
  } else {
    $("#cf-cf-chip").textContent = "not run";
    $("#cf-cf-chip").dataset.kind = "warn";
    $("#cf-cf-sub").textContent = "No recorded workerd run in this build. Run `bun compare.ts` to make one.";
  }
  table($("#cf-cf"), right);
  table($("#cf-sb"), lastRuns.in.naive || lastRuns.sep.naive ? lastRuns : null);
  $("#cf-sb-sub").textContent = "Press “Run both ways” to run all six here, now.";

  $("#cf-note").textContent = "";
  $("#cf-note").append(
    el("b", { text: "Same source. " }),
    document.createTextNode(
      `Both columns ran src/ with SHA-256 ${build?.sourceSha256?.slice(0, 16) ?? "unknown"}…; only the config file differs. CI runs the same checks against Sproutboat and against workerd. ` +
        "Where the columns differ, the runtimes differ, not the code: Sproutboat runs one request's code at a time, workerd interleaves requests at every await.",
    ),
  );

  $("#cf-run").addEventListener("click", async () => {
    const button = $("#cf-run");
    button.disabled = true;
    try {
      const run = async (base) => {
        const out = { in: {}, sep: {} };
        for (const row of ROWS) out.in[row.key] = await race(base, row.key, "in", 300);
        for (const row of ROWS) out.sep[row.key] = await race(base, row.key, "sep", 40);
        return out;
      };
      const mine = await run("");
      Object.assign(lastRuns.in, mine.in);
      Object.assign(lastRuns.sep, mine.sep);
      table($("#cf-sb"), mine);
      $("#cf-sb-sub").textContent = `Ran just now on ${info?.runtime ?? "this server"}.`;
      if (info?.compareUrl) {
        const theirs = await run(info.compareUrl.replace(/\/$/, ""));
        table($("#cf-cf"), theirs);
      }
    } catch (error) {
      $("#cf-sb-sub").textContent =
        error.status === 429 ? "Too many runs from your address: wait a few seconds." : `Stopped: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- 4. the binary
function size(bytes) {
  return `${fmt(bytes / 1_000_000, 1)} MB`;
}
function mine(files) {
  const platform = `${navigator.userAgentData?.platform ?? navigator.platform ?? ""}`.toLowerCase();
  const wanted = platform.includes("mac")
    ? "darwin-arm64"
    : platform.includes("linux") || platform.includes("android")
      ? "linux-x64"
      : "";
  return files.find((file) => file.target === wanted) ?? files[0];
}
function copyButton(text) {
  const button = el("button", { class: "btn small copy", type: "button", text: "Copy" });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Press ⌘C";
    }
    setTimeout(() => (button.textContent = "Copy"), 1400);
  });
  return button;
}
function binary() {
  const bin = build?.binaries;
  const files = $("#bin-files");
  if (info?.edition === "standalone") {
    $("#bin-sub").textContent = "You are running it: this page is being served by the binary.";
    $("#bin-chip").textContent = "this binary";
    $("#bin-chip").dataset.kind = "live";
    files.replaceChildren(
      el("p", {
        class: "note",
        text: "Its state lives in a folder next to it (showcase.data). Stop it and start it again and the page comes back; the race tables are emptied at the end of every run.",
      }),
    );
    return;
  }
  if (!bin) {
    $("#bin-chip").textContent = "not built";
    $("#bin-chip").dataset.kind = "warn";
    $("#bin-sub").textContent = "No binaries in this build.";
    files.replaceChildren(
      el("p", {
        class: "note",
        text: "Run `bun run binaries` in examples/showcase, then `bun run build`: it builds each target with `sproutboat build --standalone --release`, measures it and puts it in site/downloads/.",
      }),
    );
    return;
  }
  $("#bin-sub").textContent = `Built ${bin.builtAt.slice(0, 10)} with ${bin.cli}, on ${bin.host}.`;
  const best = mine(bin.files);
  const head = el(
    "thead",
    {},
    el(
      "tr",
      {},
      el("th", { text: "Build" }),
      el("th", { text: "Size" }),
      el("th", { class: "hide-sm", text: "SHA-256" }),
      el("th", { text: "" }),
    ),
  );
  const body = el(
    "tbody",
    {},
    ...bin.files.map((file) =>
      el(
        "tr",
        {},
        el("td", { text: file.label + (file === best ? " (your machine)" : "") }),
        el("td", { class: "size num", text: size(file.bytes) }),
        el("td", { class: "hash hide-sm", text: file.sha256.slice(0, 16) + "…" }),
        el(
          "td",
          {},
          el("a", { class: "btn small", href: `/downloads/${file.name}`, download: file.name, text: "Download" }),
        ),
      ),
    ),
  );
  files.replaceChildren(el("table", { class: "files" }, head, body));
  const run = `curl -LO ${location.origin}/downloads/${best.name}\nchmod +x ${best.name}\nPORT=3000 ./${best.name}`;
  files.append(el("div", { class: "term" }, document.createTextNode(run), copyButton(run)));
  const items = [["Smallest build", size(Math.min(...bin.files.map((f) => f.bytes)))]];
  if (bin.cold) {
    items.push(["Start to first answer", fmt(bin.cold.laterMedianMs), "ms median"]);
    items.push(["The very first start", fmt(bin.cold.firstMs), "ms"]);
  }
  setReadouts("#bin-readouts", items);
  $("#bin-note").textContent =
    `Sizes are the files in this page's downloads folder (${bin.release ? "release build, LTO" : "built without LTO"}). ${bin.cold ? `Start time: ${bin.cold.runs.length} starts of the ${bin.cold.target} binary from nothing to its first /healthz answer, ${bin.cold.date}, on ${bin.cold.host}.` : ""}`;
}

// ---------------------------------------------------------------- code panels
let codePromise;
const loadCode = () => (codePromise ??= getJson("/code.json").catch(() => ({ panels: {} })));
document.querySelectorAll("details.code").forEach((details) => {
  details.addEventListener("toggle", async () => {
    const body = $(".code-body", details);
    if (!details.open || body.childElementCount) return;
    const { panels } = await loadCode();
    const blocks = panels[details.dataset.panel] ?? [];
    if (!blocks.length) {
      body.append(el("p", { class: "empty-code", text: "No code in this build." }));
      return;
    }
    for (const block of blocks) {
      const root = el(
        "div",
        { class: "block" },
        el("header", {}, el("span", { text: block.label }), copyButton(block.text)),
      );
      root.insertAdjacentHTML("beforeend", block.html);
      body.append(root);
    }
  });
});

await Promise.all([density(), wakeSetup(), compare()]);
binary();
