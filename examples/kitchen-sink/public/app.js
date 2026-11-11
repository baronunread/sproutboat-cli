// The kitchen-sink dashboard. No framework and no build step: every tile calls
// this app's own /api routes, and every number comes from a response header, a
// response body or build-info.json (written by build-web.ts).
(function () {
  "use strict";

  var $ = function (sel) {
    return document.querySelector(sel);
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtMs(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return "–";
    return ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : String(Math.round(ms));
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function ago(iso) {
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (isNaN(s)) return "";
    if (s < 5) return "now";
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }

  // ---- theme and copy buttons ----------------------------------------------
  var root = document.documentElement;
  function applyTheme(t) {
    root.classList.toggle("dark", t === "dark");
    var use = document.querySelector("[data-theme-toggle] use");
    if (use) use.setAttribute("href", t === "dark" ? "#i-sun" : "#i-moon");
  }
  applyTheme(root.classList.contains("dark") ? "dark" : "light");
  $("[data-theme-toggle]").addEventListener("click", function () {
    var next = root.classList.contains("dark") ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem("sb-theme", next);
    } catch {}
  });

  document.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-copy]");
    if (!btn) return;
    try {
      navigator.clipboard.writeText(btn.getAttribute("data-copy"));
    } catch {}
    var prev = btn.innerHTML;
    btn.innerHTML = '<svg class="sb-icon"><use href="#i-check"/></svg> Copied';
    setTimeout(function () {
      btn.innerHTML = prev;
    }, 1400);
  });

  // ---- measured requests ------------------------------------------------------
  var samples = []; // server ms of the last requests from this tab
  var p50hist = [];
  var p99hist = [];
  var logCount = 0;

  function percentile(sorted, q) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  }

  function spark(svg, data) {
    if (data.length < 2) {
      svg.innerHTML = "";
      return;
    }
    var mn = Math.min.apply(null, data);
    var mx = Math.max.apply(null, data);
    var span = mx - mn || 1;
    var pts = data.map(function (v, i) {
      return [(i / (data.length - 1)) * 100, 27 - ((v - mn) / span) * 22];
    });
    var line =
      "M" +
      pts
        .map(function (p) {
          return p[0].toFixed(1) + " " + p[1].toFixed(1);
        })
        .join("L");
    svg.innerHTML =
      '<path class="a" d="' +
      line +
      'L100 30L0 30Z"/><path class="l" d="' +
      line +
      '" vector-effect="non-scaling-stroke"/>';
  }

  function drawChart() {
    var svg = $("#chart");
    $("#chart-empty").hidden = samples.length > 0;
    if (!samples.length) {
      svg.innerHTML = "";
      $("#chart-max").textContent = "";
      return;
    }
    var w = 600;
    var h = 200;
    var mx = Math.max.apply(null, samples) * 1.15 || 1;
    var sorted = samples.slice().sort(function (a, b) {
      return a - b;
    });
    var med = percentile(sorted, 0.5);
    function y(v) {
      return h - 12 - (v / mx) * (h - 28);
    }
    var step = samples.length > 1 ? w / (samples.length - 1) : 0;
    var d =
      "M" +
      samples
        .map(function (v, i) {
          return (samples.length > 1 ? i * step : w / 2).toFixed(1) + " " + y(v).toFixed(1);
        })
        .join("L");
    var grid = "";
    for (var i = 1; i < 5; i++)
      grid += '<line class="gl" x1="0" x2="' + w + '" y1="' + (i * h) / 5 + '" y2="' + (i * h) / 5 + '"/>';
    svg.innerHTML =
      grid +
      (samples.length > 1 ? '<path class="ar" d="' + d + "L" + w + " " + h + "L0 " + h + 'Z"/>' : "") +
      '<path class="ln" d="' +
      d +
      '"/>' +
      '<line class="dep" x1="0" x2="' +
      w +
      '" y1="' +
      y(med) +
      '" y2="' +
      y(med) +
      '" style="stroke:var(--sb-chart-series)"/>';
    $("#chart-max").textContent = "max " + fmtMs(Math.max.apply(null, samples)) + " ms";
    $("#ax-l").textContent = samples.length + (samples.length === 1 ? " request" : " requests") + ", oldest";
  }

  function renderMetrics() {
    var sorted = samples.slice().sort(function (a, b) {
      return a - b;
    });
    var p50 = percentile(sorted, 0.5);
    var p99 = percentile(sorted, 0.99);
    $("#m-p50").textContent = fmtMs(p50);
    $("#m-p99").textContent = fmtMs(p99);
    var of = "of the last " + samples.length + " from this tab";
    $("#m-p50-d").textContent = samples.length ? "Median " + of : "Make a request";
    $("#m-p99-d").textContent = samples.length ? "Slowest 1% " + of : "Make a request";
    if (p50 !== null) {
      p50hist.push(p50);
      p99hist.push(p99);
      if (p50hist.length > 28) {
        p50hist.shift();
        p99hist.shift();
      }
      spark($("#sp-p50"), p50hist);
      spark($("#sp-p99"), p99hist);
    }
    drawChart();
  }

  var logEl = $("#log");
  function logLine(method, path, status, serverMs, user) {
    if (!logCount) clear(logEl);
    logCount++;
    var li = el("li", user ? "u" : "");
    li.appendChild(el("time", "", new Date().toLocaleTimeString([], { hour12: false })));
    li.appendChild(el("span", "m", method));
    li.appendChild(el("span", "r", path));
    li.appendChild(el("span", status >= 400 || status === 0 ? "bad" : "ok", status ? String(status) : "ERR"));
    li.lastChild.style.marginInlineStart = "auto";
    li.appendChild(el("span", "p tnum", serverMs === null ? "ws" : fmtMs(serverMs) + "ms"));
    logEl.appendChild(li);
    while (logEl.children.length > 14) logEl.removeChild(logEl.firstChild);
    $("#log-count").textContent = logCount + (logCount === 1 ? " request" : " requests");
  }

  function parseServerTiming(header) {
    if (!header) return null;
    var m = /dur=([0-9.]+)/.exec(header);
    return m ? parseFloat(m[1]) : null;
  }

  // Every call goes through here: it reads Server-Timing, records the request
  // and returns { status, data, ms }. `user` marks a click rather than a refresh.
  async function api(path, opt) {
    opt = opt || {};
    var method = opt.method || "GET";
    var init = { method: method, headers: {} };
    if (opt.json !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(opt.json);
    }
    if (opt.text !== undefined) {
      init.headers["content-type"] = "text/plain";
      init.body = opt.text;
    }
    var res;
    try {
      res = await fetch(path, init);
    } catch {
      logLine(method, path, 0, null, opt.user);
      throw e;
    }
    var data = null;
    try {
      data = await res.json();
    } catch {}
    var ms = parseServerTiming(res.headers.get("server-timing"));
    if (ms === null && data && data.ms !== undefined) ms = Number(data.ms);
    logLine(method, path, res.status, ms, opt.user);
    if (ms !== null) {
      samples.push(ms);
      if (samples.length > 60) samples.shift();
      renderMetrics();
    }
    return { status: res.status, ok: res.ok, data: data, ms: ms };
  }

  function lat(id, ms) {
    var node = $("#lat-" + id);
    node.querySelector("b").textContent = fmtMs(ms);
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  }

  function setHelp(id, text, good) {
    var node = $(id);
    node.textContent = text || "";
    node.classList.toggle("ok", !!good);
  }

  // A tile whose binding this build does not have.
  function notAvailable(tileId, title, text) {
    var tile = $(tileId);
    var body = tile.querySelector(".card-b");
    var kids = Array.prototype.slice.call(body.children);
    kids.forEach(function (k) {
      if (!k.classList.contains("tsub") && !k.classList.contains("foot")) k.hidden = true;
    });
    var box = el("div", "state na");
    box.appendChild(el("b", "", title));
    box.appendChild(el("span", "", text));
    body.insertBefore(box, body.querySelector(".foot"));
  }

  // ---- code panels ------------------------------------------------------------
  var snippets = {};

  function highlight(code) {
    var out = document.createDocumentFragment();
    var re =
      /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(const|let|await|async|return|new|throw|if|for|of|function|class|export|default|try|catch|extends|this)\b|\b([A-Za-z_$][\w$]*)(?=\()/g;
    var last = 0;
    var m;
    while ((m = re.exec(code))) {
      if (m.index > last) out.appendChild(document.createTextNode(code.slice(last, m.index)));
      var cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "k" : "f";
      out.appendChild(el("span", cls, m[0]));
      last = m.index + m[0].length;
    }
    if (last < code.length) out.appendChild(document.createTextNode(code.slice(last)));
    return out;
  }

  function fillCode(pop) {
    if (pop.dataset.filled) return;
    var key = pop.getAttribute("data-code");
    var head = el("div", "cp-h");
    head.appendChild(el("span", "mono", "src/index.js · " + key));
    var close = el("button", "ibtn");
    close.type = "button";
    close.setAttribute("aria-label", "Close code");
    close.innerHTML = '<svg class="sb-icon"><use href="#i-x"/></svg>';
    close.addEventListener("click", function () {
      toggleCode(pop.parentElement.querySelector(".ctog"), false);
    });
    head.appendChild(close);
    var pre = el("pre", "code");
    pre.tabIndex = 0;
    var text = snippets[key];
    if (text) pre.appendChild(highlight(text));
    else pre.textContent = "The excerpt is written by build-web.ts. Run `bun run build` in examples/kitchen-sink.";
    pop.appendChild(head);
    pop.appendChild(pre);
    pop.dataset.filled = "1";
  }

  function toggleCode(btn, force) {
    var pop = document.getElementById(btn.getAttribute("aria-controls"));
    var open = force === undefined ? btn.getAttribute("aria-expanded") !== "true" : force;
    if (open) {
      document.querySelectorAll(".ctog[aria-expanded='true']").forEach(function (other) {
        if (other !== btn) toggleCode(other, false);
      });
      fillCode(pop);
    }
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    pop.hidden = !open;
    btn.closest(".tile").classList.toggle("open", open);
  }

  document.querySelectorAll(".ctog").forEach(function (btn) {
    btn.addEventListener("click", function () {
      toggleCode(btn);
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    var open = document.querySelector(".ctog[aria-expanded='true']");
    if (open) {
      toggleCode(open, false);
      open.focus();
    }
  });
  document.addEventListener("click", function (event) {
    var open = document.querySelector(".ctog[aria-expanded='true']");
    if (open && !event.target.closest(".tile.open")) toggleCode(open, false);
  });

  // ---- build info --------------------------------------------------------------
  var build = null;

  async function loadBuild() {
    try {
      var res = await fetch("/build-info.json");
      build = await res.json();
    } catch {
      build = null;
    }
    if (!build) {
      $("#compat").textContent = "unknown";
      $("#built").textContent = "no build info";
      $("#size-note").textContent =
        "build-info.json is missing. Run bun run build in examples/kitchen-sink to measure sizes.";
      $("#snippet-code").textContent = "build-info.json is missing. Run bun run build in examples/kitchen-sink.";
      return;
    }
    snippets = build.snippets || {};
    $("#compat").textContent = build.compatibilityDate;
    $("#built").textContent = build.builtAt.slice(0, 10);
    $("#n-bindings").textContent = String(build.bindings.length);
    $("#sec-n").textContent = String(build.secrets.length);
    $("#cron-expr").textContent = build.crons[0] || "no cron";

    var mod = build.module.bytes;
    var ast = build.assets.reduce(function (sum, a) {
      return sum + a.bytes;
    }, 0);
    $("#m-mod").textContent = mod < 1024 * 100 ? (mod / 1024).toFixed(1) : String(Math.round(mod / 1024));
    $("#m-ast").textContent = ast >= 1048576 ? (ast / 1048576).toFixed(2) : String(Math.round(ast / 1024));
    $("#m-ast-u").textContent = ast >= 1048576 ? "MB" : "KB";
    $("#m-ast-d").textContent = build.assets.length + " files: this page and its fonts";
    $("#snippet-code").textContent = "";
    $("#snippet-code").appendChild(highlight(snippets.kv || ""));

    var groups = [
      ["Worker module", "src/index.js", mod, "var(--sb-chart-series)"],
      ["Fonts", "Figtree, JetBrains Mono", sumBy("woff2"), "var(--sb-chart-requests)"],
      ["Page script and styles", "app.js, app.css", sumBy("js") + sumBy("css"), "var(--sb-chart-2xx)"],
      ["HTML", "index.html", sumBy("html"), "var(--sb-chart-4xx)"],
      [
        "Font licences",
        "OFL texts",
        ast - sumBy("woff2") - sumBy("js") - sumBy("css") - sumBy("html"),
        "var(--sb-chart-other)",
      ],
    ];
    var total = mod + ast;
    $("#size-total").textContent = fmtBytes(total) + " total";
    var seg = $("#seg");
    var sz = $("#sz");
    groups.forEach(function (g) {
      if (g[2] <= 0) return;
      var i = el("i");
      i.style.flex = String(g[2]);
      i.style.background = g[3];
      i.title = g[0] + ": " + fmtBytes(g[2]);
      seg.appendChild(i);
      var sw = el("span", "sw");
      sw.style.background = g[3];
      sz.appendChild(sw);
      sz.appendChild(el("span", "", g[0]));
      sz.appendChild(el("b", "", fmtBytes(g[2])));
      sz.appendChild(el("em", "", Math.round((g[2] / total) * 100) + "%"));
    });
    $("#size-note").textContent =
      "Source and assets as measured at build time. A compiled binary adds the runtime, SQLite and TLS: sproutboat build --standalone prints its size.";
  }

  function sumBy(ext) {
    return build.assets.reduce(function (sum, a) {
      return sum + (a.path.slice(-ext.length - 1) === "." + ext ? a.bytes : 0);
    }, 0);
  }

  // ---- connection badge ---------------------------------------------------------
  function badge(node, kind, label, mark) {
    node.className = "badge" + (kind ? " " + kind : "");
    clear(node);
    node.appendChild(el("span", "shape " + (mark || "circle")));
    node.appendChild(document.createTextNode(label));
  }

  var info = null;
  async function loadInfo() {
    try {
      var res = await api("/api/info");
      if (!res.ok) throw new Error("status " + res.status);
      info = res.data;
      badge($("#conn"), "ok", "Online", "live");
      if (info.requests !== null && info.requests !== undefined)
        $("#m-req").textContent = info.requests.toLocaleString("en-US");
      else $("#m-req").textContent = "n/a";
      $("#r2-cap").textContent = String(Math.floor(info.max_upload_bytes / 1024));
      var kinds = ["kv", "d1", "r2", "queue", "durable_object", "service"];
      var live = kinds.filter(function (k) {
        return info.bindings[k];
      }).length;
      $("#live-count").textContent = live + " of " + kinds.length + " bindings in this build";
      if (!info.bindings.service) {
        notAvailable(
          "#t-svc",
          "Not in standalone",
          "This build has no service binding. A standalone binary has no edge to route a call to another deployment. Deploy to Cloud together with quote-service to use this tile.",
        );
        $("#svc-state").hidden = true;
      }
    } catch {
      badge($("#conn"), "bad", "Offline", "tri");
      $("#live-count").textContent = "the API did not answer";
    }
  }

  // ---- KV --------------------------------------------------------------------------
  function renderKv(data, withOps) {
    $("#kv-n").textContent = Number(data.n).toLocaleString("en-US");
    $("#kv-keys").textContent = data.keys + (data.keys === 1 ? " key" : " keys");
    if (!withOps) return;
    var ul = $("#kv-ops");
    clear(ul);
    data.ops.forEach(function (op) {
      var li = el("li");
      li.appendChild(el("span", "m", op.op));
      li.appendChild(el("span", "k", "counter:home"));
      li.appendChild(el("span", "v", String(op.value)));
      li.appendChild(el("span", "p tnum", fmtMs(op.ms) + "ms"));
      ul.appendChild(li);
    });
  }

  async function kvLoad(user) {
    try {
      var res = await api("/api/kv", { user: user });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderKv(res.data, false);
      lat("kv", res.ms);
      setHelp("#kv-help", "");
    } catch (e) {
      setHelp("#kv-help", "Could not read the counter: " + e.message);
    }
  }

  $("#kv-get").addEventListener("click", function () {
    kvLoad(true);
  });
  $("#kv-b").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var res = await api("/api/kv/incr", { method: "POST", user: true });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderKv(res.data, true);
      lat("kv", res.ms);
      setHelp("#kv-help", "");
    } catch (e) {
      setHelp("#kv-help", "Could not increment: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- D1 ---------------------------------------------------------------------------
  var seenRows = {};
  function renderGuestbook(data) {
    var body = $("#gb");
    clear(body);
    if (!data.rows.length) {
      var tr = el("tr");
      tr.appendChild(el("td", "empty", "No entries yet. Sign the guestbook."));
      body.appendChild(tr);
    }
    data.rows.forEach(function (row) {
      var tr = el("tr", seenRows[row.id] ? "" : "new");
      seenRows[row.id] = true;
      tr.appendChild(el("td", "id", "#" + row.id));
      tr.appendChild(el("td", "nm", row.name));
      tr.appendChild(el("td", "t", row.msg));
      tr.appendChild(el("td", "et", ago(row.at)));
      body.appendChild(tr);
    });
    $("#gb-n").textContent = Number(data.total).toLocaleString("en-US");
    var box = $("#sql");
    clear(box);
    data.sql.forEach(function (st) {
      var line = el("span", "c");
      line.appendChild(highlightSql(st.sql + ";"));
      box.appendChild(line);
      var binds = st.binds.length
        ? "bound " +
          st.binds
            .map(function (b) {
              return "'" + String(b).slice(0, 24) + "'";
            })
            .join(", ") +
          " · "
        : "";
      var extra = st.rows_read !== undefined ? ", " + st.rows_read + " rows read" : "";
      box.appendChild(el("span", "c muted", "-- " + binds + fmtMs(st.ms) + " ms" + extra));
    });
    var last = data.sql[data.sql.length - 1];
    $("#gb-q").textContent = last ? "query " + fmtMs(last.ms) + " ms" : "";
  }

  function highlightSql(sql) {
    var out = document.createDocumentFragment();
    var re = /\b(SELECT|INSERT INTO|DELETE FROM|FROM|WHERE|ORDER BY|LIMIT|VALUES|DESC|max|count)\b/g;
    var last = 0;
    var m;
    while ((m = re.exec(sql))) {
      if (m.index > last) out.appendChild(document.createTextNode(sql.slice(last, m.index)));
      out.appendChild(el("span", m[1] === "max" || m[1] === "count" ? "f" : "k", m[0]));
      last = m.index + m[0].length;
    }
    if (last < sql.length) out.appendChild(document.createTextNode(sql.slice(last)));
    return out;
  }

  async function gbLoad(user) {
    try {
      var res = await api("/api/guestbook", { user: user });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderGuestbook(res.data);
      lat("d1", res.ms);
    } catch (e) {
      setHelp("#gb-help", "Could not read the guestbook: " + e.message);
    }
  }

  $("#gb-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var name = $("#gb-name").value.trim();
    var msg = $("#gb-msg").value.trim();
    if (!name || !msg) {
      setHelp("#gb-help", "Add a name and a message.");
      return;
    }
    setHelp("#gb-help", "");
    var btn = this.querySelector("button");
    btn.disabled = true;
    try {
      var res = await api("/api/guestbook", { method: "POST", json: { name: name, msg: msg }, user: true });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderGuestbook(res.data);
      lat("d1", res.ms);
      $("#gb-msg").value = "";
    } catch (e) {
      setHelp("#gb-help", "Could not sign: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- R2 ---------------------------------------------------------------------------
  function renderFiles(data) {
    var body = $("#r2-list");
    clear(body);
    if (!data.objects.length) {
      var tr = el("tr");
      tr.appendChild(el("td", "empty", "The bucket is empty. Upload a text file."));
      body.appendChild(tr);
    }
    data.objects.slice(0, 5).forEach(function (obj) {
      var tr = el("tr");
      var t = el("td", "t");
      t.insertAdjacentHTML("afterbegin", '<svg class="sb-icon"><use href="#i-file"/></svg>');
      var a = el("a", "", obj.name);
      a.href = "/api/r2/file?name=" + encodeURIComponent(obj.name);
      a.title = "Download " + obj.name;
      t.appendChild(a);
      tr.appendChild(t);
      tr.appendChild(el("td", "", fmtBytes(obj.size)));
      var act = el("td", "act");
      var del = el("button", "ibtn");
      del.type = "button";
      del.setAttribute("aria-label", "Delete " + obj.name);
      del.innerHTML = '<svg class="sb-icon"><use href="#i-trash"/></svg>';
      del.addEventListener("click", function () {
        r2Delete(obj.name);
      });
      act.appendChild(del);
      tr.appendChild(act);
      body.appendChild(tr);
    });
    $("#r2-n").textContent =
      String(data.objects.length) + (data.truncated ? "+" : "") + (data.objects.length > 5 ? " (newest 5 shown)" : "");
    $("#r2-sz").textContent = fmtBytes(data.bytes);
  }

  async function r2Load(user) {
    try {
      var res = await api("/api/r2", { user: user });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderFiles(res.data);
      lat("r2", res.ms);
    } catch (e) {
      setHelp("#r2-help", "Could not list the bucket: " + e.message);
    }
  }

  async function r2Upload(name, text) {
    var cap = info ? info.max_upload_bytes : 65536;
    if (text.length > cap) {
      setHelp(
        "#r2-help",
        name + " is " + fmtBytes(text.length) + ". This build accepts " + fmtBytes(cap) + " per file.",
      );
      return;
    }
    if (text.indexOf("\u0000") !== -1 || text.indexOf("�") !== -1) {
      setHelp("#r2-help", name + " is not a text file. This tile sends the file as text.");
      return;
    }
    setHelp("#r2-help", "");
    try {
      var res = await api("/api/r2?name=" + encodeURIComponent(name), { method: "PUT", text: text, user: true });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderFiles(res.data);
      lat("r2", res.ms);
      setHelp("#r2-help", "Stored " + res.data.name + " in " + fmtMs(res.ms) + " ms (server).", true);
    } catch (e) {
      setHelp("#r2-help", "Upload failed: " + e.message);
    }
  }

  async function r2Delete(name) {
    try {
      var res = await api("/api/r2?name=" + encodeURIComponent(name), { method: "DELETE", user: true });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderFiles(res.data);
      lat("r2", res.ms);
      setHelp("#r2-help", "");
    } catch (e) {
      setHelp("#r2-help", "Delete failed: " + e.message);
    }
  }

  async function handleFile(file) {
    if (!file) return;
    var text;
    try {
      text = await file.text();
    } catch {
      setHelp("#r2-help", "Could not read " + file.name + ".");
      return;
    }
    r2Upload(file.name, text);
  }

  $("#r2-pick").addEventListener("click", function () {
    $("#r2-file").click();
  });
  $("#r2-file").addEventListener("change", function () {
    handleFile(this.files[0]);
    this.value = "";
  });
  $("#r2-sample").addEventListener("click", function () {
    var now = new Date();
    var name = "note-" + now.toTimeString().slice(0, 8).replace(/:/g, "") + ".txt";
    r2Upload(name, "Note written at " + now.toISOString() + " from the kitchen-sink dashboard.\n");
  });
  var dz = $("#dz");
  ["dragenter", "dragover"].forEach(function (name) {
    dz.addEventListener(name, function (event) {
      event.preventDefault();
      dz.classList.add("over");
    });
  });
  ["dragleave", "drop"].forEach(function (name) {
    dz.addEventListener(name, function (event) {
      event.preventDefault();
      dz.classList.remove("over");
    });
  });
  dz.addEventListener("drop", function (event) {
    handleFile(event.dataTransfer.files[0]);
  });

  // ---- Durable Object chat over WebSocket -------------------------------------------
  var myName;
  try {
    myName = localStorage.getItem("sb-chat-name");
  } catch {}
  if (!myName) {
    myName = "guest-" + Math.random().toString(36).slice(2, 6);
    try {
      localStorage.setItem("sb-chat-name", myName);
    } catch {}
  }

  var ws = null;
  var chatBox = $("#chat");
  var chatCount = 0;
  var wsOpened = false;

  function chatState(kind, label, mark) {
    badge($("#ws-state"), kind, label, mark);
  }

  function chatNote(text, cls) {
    var div = el("div", "empty" + (cls ? " " + cls : ""), text);
    chatBox.appendChild(div);
  }

  function addBubble(msg) {
    if (!chatCount) clear(chatBox);
    chatCount++;
    var mine = msg.name === myName;
    var b = el("div", "bub" + (mine ? " me" : ""));
    b.appendChild(el("small", "", mine ? "you" : msg.name));
    b.appendChild(document.createTextNode(msg.text));
    chatBox.appendChild(b);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function renderPresence(p) {
    $("#who").textContent =
      p.n +
      (p.n === 1 ? " socket" : " sockets") +
      (p.names.length
        ? ": " + p.names.slice(0, 4).join(", ") + (p.names.length > 4 ? " +" + (p.names.length - 4) : "")
        : "");
  }

  function connectChat() {
    clear(chatBox);
    chatCount = 0;
    wsOpened = false;
    $("#ws-reconnect").hidden = true;
    chatState("", "Connecting", "ring");
    var started = performance.now();
    var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/chat";
    try {
      ws = new WebSocket(url);
    } catch (e) {
      chatState("bad", "Unavailable", "tri");
      chatNote("This browser could not create the WebSocket: " + e.message, "bad");
      return;
    }
    ws.addEventListener("open", function () {
      wsOpened = true;
      chatState("ok", "Open", "live");
      logLine("GET", "/api/chat", 101, null, false);
      $("#frame").textContent =
        "Connected in " + fmtMs(performance.now() - started) + " ms (round trip, including the upgrade)";
      ws.send(JSON.stringify({ type: "hello", name: myName }));
    });
    ws.addEventListener("message", function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "history") {
        clear(chatBox);
        chatCount = 0;
        msg.messages.forEach(addBubble);
        if (!msg.messages.length) chatNote("No messages yet. Say something.");
      } else if (msg.type === "presence") {
        renderPresence(msg);
      } else if (msg.type === "msg") {
        addBubble(msg);
        lat("do", msg.ms);
        if (msg.name === myName && msg.sent) {
          $("#frame").textContent =
            "Round trip " + fmtMs(Date.now() - msg.sent) + " ms · the room handled it in " + fmtMs(msg.ms) + " ms";
        }
      }
    });
    ws.addEventListener("close", function () {
      $("#ws-reconnect").hidden = false;
      $("#who").textContent = "Not connected";
      if (wsOpened) {
        chatState("warn", "Closed", "tri");
      } else {
        chatState("bad", "Failed", "tri");
        clear(chatBox);
        chatNote(
          "The connection closed before it opened. Check that whatever serves this page forwards WebSocket upgrades to the app.",
          "bad",
        );
      }
    });
  }

  $("#ws-reconnect").addEventListener("click", connectChat);
  $("#chat-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var input = $("#chat-in");
    var text = input.value.trim();
    if (!text) return;
    if (!ws || ws.readyState !== 1) {
      $("#frame").textContent = "Not connected. Use Reconnect.";
      return;
    }
    // `sent` is echoed back by the room so this page can time the round trip.
    ws.send(JSON.stringify({ type: "msg", text: text, sent: Date.now() }));
    input.value = "";
  });

  // ---- Queue and cron feed -------------------------------------------------------------
  var skew = 0;
  var seenEvents = {};
  var cronEveryMin = null;
  var lastQueue = null;

  function renderQueue(data) {
    lastQueue = data;
    skew = data.now - Date.now();
    var c = data.counts || {};
    var queued = Number(c.queued || 0);
    var processed = Number(c.processed || 0);
    $("#qd").textContent = String(Math.max(0, queued - processed));
    $("#qp").textContent = processed.toLocaleString("en-US");
    $("#qc").textContent = Number(c.crons || 0).toLocaleString("en-US");
    var ul = $("#jobs");
    clear(ul);
    if (!data.recent.length) ul.appendChild(el("li", "empty", "Nothing yet. Enqueue a job or wait for the cron run."));
    data.recent.forEach(function (ev) {
      var key = ev.kind + ev.at;
      var li = el("li", seenEvents[key] === undefined && Object.keys(seenEvents).length ? "fresh" : "");
      seenEvents[key] = true;
      li.title = new Date(ev.at).toLocaleTimeString();
      var cron = ev.kind === "cron";
      var b = el("span", "badge " + (cron ? "info" : "ok"));
      b.appendChild(el("span", "shape " + (cron ? "square" : "circle")));
      b.appendChild(document.createTextNode(cron ? "Cron" : "Done"));
      li.appendChild(b);
      li.appendChild(el("span", "jt", (cron ? "cron " : "job ") + ev.label));
      li.appendChild(el("span", "jm", fmtMs(ev.ms) + " ms · " + ago(ev.at)));
      ul.appendChild(li);
    });
    var lastCron = data.recent.filter(function (e) {
      return e.kind === "cron";
    })[0];
    var out = $("#cron-last");
    clear(out);
    if (lastCron) {
      var cb = el("span", "badge ok");
      cb.appendChild(el("span", "shape circle"));
      cb.appendChild(document.createTextNode("Last cron " + fmtMs(lastCron.ms) + " ms · " + ago(lastCron.at)));
      out.appendChild(cb);
    } else out.textContent = "No cron run yet";
  }

  async function queueLoad(user) {
    try {
      var res = await api("/api/queue", { user: user });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderQueue(res.data);
      if (user) lat("q", res.ms);
      return res.data;
    } catch {
      return null;
    }
  }

  $("#q-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var btn = $("#q-b");
    btn.disabled = true;
    try {
      var res = await api("/api/queue/enqueue", { method: "POST", json: { label: $("#q-label").value }, user: true });
      if (!res.ok) throw new Error((res.data && res.data.error) || "status " + res.status);
      renderQueue(res.data);
      lat("q", res.ms);
      // The consumer runs after the response: poll until it has delivered the job.
      var tries = 0;
      var timer = setInterval(async function () {
        tries++;
        var data = await queueLoad(false);
        var waiting = data ? Number(data.counts.queued || 0) - Number(data.counts.processed || 0) : 0;
        if (tries >= 12 || waiting <= 0) clearInterval(timer);
      }, 700);
    } catch (e) {
      $("#jobs").insertBefore(el("li", "empty", "Could not enqueue: " + e.message), $("#jobs").firstChild);
    } finally {
      btn.disabled = false;
    }
  });

  var polls = 0;
  setInterval(function () {
    if (document.hidden) return;
    queueLoad(false);
    // The request count moves with every visitor, so refresh it now and then.
    if (++polls % 3 === 0)
      api("/api/info").then(function (res) {
        if (res.ok && res.data.requests !== null) $("#m-req").textContent = res.data.requests.toLocaleString("en-US");
      });
  }, 5000);

  // Cron countdown, for expressions of the form */N * * * *.
  function tickCron() {
    var fill = $("#cdfill");
    if (!cronEveryMin) {
      $("#cd").textContent = "–";
      fill.style.width = "0%";
      return;
    }
    var period = cronEveryMin * 60000;
    var now = Date.now() + skew;
    var next = Math.ceil((now + 1) / period) * period;
    var left = next - now;
    var s = Math.ceil(left / 1000);
    $("#cd").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    fill.style.width = (100 * (1 - left / period)).toFixed(1) + "%";
    $("#cdbar").setAttribute("aria-valuenow", String(Math.round((period - left) / 1000)));
    if (left < 1100 && lastQueue && !tickCron.pending) {
      tickCron.pending = setTimeout(function () {
        tickCron.pending = null;
        queueLoad(false);
      }, 2500);
    }
  }
  setInterval(tickCron, 1000);

  // ---- Service binding -----------------------------------------------------------------
  var calls = 0;
  $("#qb").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    var qt = $("#qt");
    var res$ = $("#qres");
    try {
      var res = await api("/api/quote", { user: true });
      calls++;
      $("#qm").textContent = calls + (calls === 1 ? " call" : " calls");
      lat("svc", res.ms);
      clear(res$);
      qt.className = "quoteb";
      if (res.data && res.data.ok) {
        qt.textContent = "“" + res.data.quote.content + "”";
        res$.appendChild(el("span", "by", res.data.quote.author));
        res$.appendChild(el("span", "muted", "200 · " + fmtMs(res.ms) + " ms"));
        badge($("#svc-state"), "ok", "Answered", "circle");
      } else {
        var reason = res.data && res.data.reason;
        qt.className = "quoteb";
        qt.textContent = "";
        var box = el("div", "state " + (reason === "no-binding" ? "na" : "bad"));
        box.appendChild(el("b", "", reason === "no-binding" ? "Not in standalone" : "quote-service did not answer"));
        box.appendChild(el("span", "mono", (res.data && res.data.error) || "status " + res.status));
        box.appendChild(
          el(
            "span",
            "",
            reason === "no-binding"
              ? "This build has no service binding."
              : "Deploy examples/quote-service first, then redeploy this app.",
          ),
        );
        qt.appendChild(box);
        badge($("#svc-state"), "bad", "Unreachable", "tri");
      }
    } catch (e) {
      qt.textContent = "The request to this app failed: " + e.message;
      badge($("#svc-state"), "bad", "Unreachable", "tri");
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Secrets ---------------------------------------------------------------------------
  async function secretsLoad() {
    try {
      var res = await api("/api/secrets");
      if (!res.ok) throw new Error("status " + res.status);
      var box = $("#secs");
      clear(box);
      res.data.secrets.forEach(function (s) {
        var row = el("div", "sec-line");
        row.appendChild(el("span", "mono", s.name));
        var b = el("span", "badge " + (s.set ? "ok" : "warn"));
        b.appendChild(el("span", "shape " + (s.set ? "circle" : "tri")));
        b.appendChild(document.createTextNode(s.set ? "Set" : "Not set"));
        row.appendChild(b);
        box.appendChild(row);
        if (!s.set) {
          $("#revnote").textContent =
            "ADMIN_TOKEN has no value here. Set one with sproutboat secrets put ADMIN_TOKEN (or .dev.vars under sproutboat dev).";
        }
      });
      lat("sec", res.ms);
    } catch (e) {
      $("#secs").textContent = "Could not read secret status: " + e.message;
    }
  }

  $("#sec-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var token = $("#sec-val").value;
    if (!token) return;
    var note = $("#revnote");
    try {
      var res = await api("/api/secrets/check", { method: "POST", json: { token: token }, user: true });
      lat("sec", res.ms);
      if (res.status === 429) note.textContent = "Too many checks. env.THROTTLE allows 3 a minute per visitor.";
      else if (res.data && res.data.ok)
        note.textContent = "Match: the value equals env.ADMIN_TOKEN. It was compared in the worker and not returned.";
      else note.textContent = "No match. The value does not equal env.ADMIN_TOKEN.";
    } catch (e) {
      note.textContent = "The check failed: " + e.message;
    }
    $("#sec-val").value = "";
  });

  // ---- start -------------------------------------------------------------------------------
  (async function start() {
    await loadBuild();
    var m = build && build.crons[0] ? /^\*\/(\d+) \* \* \* \*$/.exec(build.crons[0]) : null;
    cronEveryMin = m ? parseInt(m[1], 10) : build && build.crons[0] === "* * * * *" ? 1 : null;
    await loadInfo();
    if (!info) return;
    var jobs = [];
    if (info.bindings.kv) jobs.push(kvLoad(false));
    if (info.bindings.d1) jobs.push(gbLoad(false));
    if (info.bindings.r2) jobs.push(r2Load(false));
    jobs.push(queueLoad(false));
    jobs.push(secretsLoad());
    await Promise.all(jobs);
    if (info.bindings.durable_object) connectChat();
    else notAvailable("#t-do", "Not in this build", "This build has no Durable Object binding.");
    tickCron();
  })();
})();
