// Client for the kitchen-sink UI. Talks only to the Sproutboat worker's JSON
// routes; every fetch here exercises a binding on the server side.

// The worker's JSON contract. Declared here rather than imported from the CLI's
// src/json.ts: this file is bundled for the browser by a separate Astro package.
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

const obj = (value: JsonValue | undefined): JsonObject =>
  value instanceof Object && !Array.isArray(value) ? value : {};
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
const text = (value: JsonValue | undefined): string =>
  value === undefined || value === null ? "" : String(value);
const isNumber = (value: JsonValue | undefined): value is number => Number.isFinite(value);
/** `created` is an ISO string, analytics `at` is an epoch ms number — both are dates. */
const when = (value: JsonValue | undefined): Date => new Date(isNumber(value) ? value : text(value));
const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Required element lookup — a missing id is a template bug, not a runtime state. */
function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}
const $ = <T extends Element = HTMLElement>(sel: string): T => q<T>(document, sel);

async function j(path: string, opts?: RequestInit): Promise<JsonValue> {
  const r = await fetch(path, opts);
  const t = await r.text();
  let b: JsonValue;
  try { b = JSON.parse(t); } catch { b = t; }
  if (!r.ok) throw new Error(text(obj(b).error) || r.statusText);
  return b;
}

/* ---- tabs ---- */
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("nav.tabs button"));
function showTab(name: string): void {
  let known = false;
  for (const b of tabButtons) {
    const on = b.dataset.tab === name;
    known = known || on;
    b.classList.toggle("active", on);
  }
  if (!known) name = "notes";
  for (const p of document.querySelectorAll<HTMLElement>(".panel")) p.hidden = p.id !== "tab-" + name;
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "attachments") void loadAttachments();
  if (name === "outbound") void loadQuote();
  if (name === "admin" && adminToken) void fetchStats(adminToken).catch(() => {});
}
tabButtons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab || "notes")));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

/* ---- session (KV) — login lives in the header ---- */
let token: string | null = null;
const loginButton = $<HTMLButtonElement>("#login");
loginButton.addEventListener("click", async () => {
  try {
    const r = await j("/login", { method: "POST" });
    token = text(obj(r).token);
    const me = await j("/whoami", { headers: { authorization: "Bearer " + token } });
    loginButton.textContent = "Log in again";
    $("#who").textContent = `${text(obj(me).user)} · token ${String(token).slice(0, 8)}… in KV`;
  } catch (e) { $("#who").textContent = message(e); }
});

/* ---- notes (D1 + DO + Queue + R2 upload) ---- */
async function loadNotes(): Promise<void> {
  const err = $("#notes-err"); err.textContent = "";
  try {
    const notes = arr(await j("/notes"));
    const ul = $("#notes-list");
    ul.innerHTML = "";
    for (const note of notes) {
      const n = obj(note);
      const li = document.createElement("li");
      li.innerHTML = `<h3></h3><div class="meta"></div>`;
      q(li, "h3").textContent = text(n.title);
      q(li, ".meta").textContent =
        `#${text(n.id)} · ${when(n.created).toLocaleString()}` + (n.attachment ? ` · 📎 ${text(n.attachment)}` : "");
      li.addEventListener("click", () => openNote(li, Number(n.id)));
      ul.append(li);
    }
  } catch (e) { err.textContent = message(e); }
}

async function openNote(li: HTMLElement, id: number): Promise<void> {
  const existing = li.querySelector(".detail");
  if (existing) { existing.remove(); return; }
  const full = obj(await j(`/notes/${id}`));
  const note = obj(full.note);
  const d = document.createElement("div");
  d.className = "detail";
  d.innerHTML = `<p class="body"></p><div class="meta">Durable Object view count: <b>${text(full.views)}</b></div>`;
  q(d, ".body").textContent = text(note.body) || "(no body)";
  if (note.attachment) {
    const a = document.createElement("a");
    a.href = "/attach/" + encodeURIComponent(text(note.attachment));
    a.textContent = "download attachment (R2 get)";
    d.append(a);
  }
  li.append(d);
}

const MAX_UPLOAD = 900 * 1024; // native-fetch server caps an inbound body at 1 MiB (issue #56)

const newNoteForm = $<HTMLFormElement>("#new-note");
newNoteForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#notes-err"); err.textContent = "";
  const ok = $("#notes-ok"); ok.textContent = "";
  const fileInput = $<HTMLInputElement>("#new-file");
  const file = fileInput.files?.[0];
  if (file && file.size > MAX_UPLOAD) {
    err.textContent = `file is ${(file.size / 1024).toFixed(0)} KB — the demo caps R2 uploads at ~900 KB (large-object R2 is tracked in issue #56)`;
    return;
  }
  try {
    const title = q<HTMLInputElement>(newNoteForm, '[name="title"]').value;
    const body = q<HTMLTextAreaElement>(newNoteForm, '[name="body"]').value;
    const created = obj(await j("/notes", { method: "POST", body: JSON.stringify({ title, body }) }));
    if (!isNumber(created.id)) throw new Error("note create returned no id");
    let msg = `note #${created.id} created`;
    if (file) {
      const r = await fetch(`/notes/${created.id}/attach`, { method: "POST", body: await file.text() });
      const rb = obj(await r.json().catch(() => null));
      if (!r.ok) throw new Error(`attach failed (${r.status}): ${text(rb.error) || "see server logs"}`);
      msg += ` · attached ${text(rb.key)} to R2`;
      await loadAttachments();
    }
    ok.textContent = msg;
    newNoteForm.reset(); fileInput.value = "";
    await loadNotes();
  } catch (e) { err.textContent = message(e); }
});

/* ---- attachments (R2) ---- */
async function loadAttachments(): Promise<void> {
  const tb = $("#att-table tbody");
  try {
    const rows = arr(await j("/attachments"));
    tb.innerHTML = "";
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="4" class="muted">no objects yet — attach a file from the Notes tab</td></tr>`; return; }
    for (const row of rows) {
      const o = obj(row);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td></td><td>${text(o.size)} B</td><td>${when(o.uploaded).toLocaleTimeString()}</td>` +
        `<td><a href="/attach/${encodeURIComponent(text(o.key))}">download</a></td>`;
      q(tr, "td").textContent = text(o.key);
      tb.append(tr);
    }
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="4" class="err">${message(e)}</td></tr>`;
  }
}
$("#refresh-att").addEventListener("click", () => void loadAttachments());

/* ---- outbound fetch ---- */
async function loadQuote(): Promise<void> {
  try {
    const q2 = obj(await j("/quote"));
    $("#quote").textContent = `“${text(q2.content)}” `;
    const by = document.createElement("span");
    by.className = "by";
    by.textContent = `— ${text(q2.author)}`;
    $("#quote").append(by);
  } catch { $("#quote").textContent = "(outbound fetch unavailable)"; }
}
$("#refresh-quote").addEventListener("click", () => void loadQuote());

/* ---- admin dashboard (secret + Analytics + cron) ---- */
let adminToken: string | null = null;
let adminTimer: ReturnType<typeof setInterval> | null = null;

$("#admin-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pw = $<HTMLInputElement>("#admin-pw").value;
  $("#admin-err").textContent = "";
  try {
    await fetchStats(pw);
    adminToken = pw;
    $("#admin-state").textContent = "unlocked · refreshing every 3s";
    $("#admin-body").hidden = false;
    if (adminTimer) clearInterval(adminTimer);
    adminTimer = setInterval(() => void fetchStats(pw).catch(() => {}), 3000);
  } catch (e) {
    $("#admin-err").textContent = /forbidden/i.test(message(e)) ? "wrong password" : message(e);
  }
});

async function fetchStats(pw: string): Promise<void> {
  const r = await fetch("/admin/stats", { headers: { "x-admin-token": pw } });
  if (r.status === 403) throw new Error("forbidden");
  const s = obj(await r.json());
  const tiles: Array<[string, JsonValue]> = [
    ["KV sessions", s.kv_sessions],
    ["D1 notes", s.d1_notes],
    ["R2 objects", s.r2_objects],
    ["Queue emails", s.queue_emails_processed],
    ["Cron heartbeats", s.cron_heartbeats],
    ["Analytics points", s.analytics_points],
  ];
  $("#tiles").innerHTML = tiles.map(([k, n]) => `<div class="tile"><div class="n">${text(n)}</div><div class="k">${k}</div></div>`).join("");
  const box = $("#events");
  box.innerHTML = `<b>recent analytics events</b> · last heartbeat ${s.last_heartbeat ? when(obj(s.last_heartbeat).at).toLocaleTimeString() : "—"}`;
  for (const event of arr(s.analytics_recent)) {
    const e = obj(event);
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = `${when(e.at).toLocaleTimeString()}  ${text(e.method)}  ${text(e.path)}`;
    box.append(line);
  }
}

/* ---- boot ---- */
showTab((location.hash || "#notes").slice(1));
void loadNotes();
