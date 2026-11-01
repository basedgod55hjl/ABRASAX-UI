/* ABRASAX Console - unified data layer.
 *
 * Binds every live surface into ONE coherent view instead of three
 * disconnected pages with different ports:
 *
 *   :9001  /brain/state   synaptic field (4096 nodes, FlyWire connectome)
 *   :8791  /api/brain     7-D Poincare map (87 units / 17 classes)
 *   :8791  /api/stress    constraint rules + breaches
 *   :8791  /api/actions   safelisted actuation + audit
 *   :1234  /v1/models     LM Studio model roster
 *   :8790  runtime        ABXU compute runtime
 *
 * Rules: every panel reports its own freshness and failure, all fetches are
 * abortable so one dead service cannot freeze the console, and nothing shows a
 * fabricated value - a down source says "down".
 */

(() => {
  "use strict";

  const BRIDGE = location.origin && location.origin.startsWith("http")
    ? location.origin : "http://127.0.0.1:8791";
  const GATEWAY = "http://127.0.0.1:9001";
  const MODELS = "http://127.0.0.1:1234";

  const $ = (id) => document.getElementById(id);

  const state = {
    brain: null, stress: null, actions: null, unity: null, info: null,
    synaptic: null, models: null, gpu: null, downloads: null,
    lastError: {}, lastOk: {}, polls: 0,
  };

  // ---------------------------------------------------------------- fetch
  async function get(url, ms = 9000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function poll(key, url, assign, ms) {
    try {
      const v = await get(url, ms);
      assign(v);
      state.lastOk[key] = Date.now();
      delete state.lastError[key];
      return true;
    } catch (e) {
      state.lastError[key] = (e && e.message) || String(e);
      return false;
    }
  }

  // ------------------------------------------------------------------ fmt
  const nf = (n, d = 0) => (typeof n === "number" && isFinite(n))
    ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
  const pct = (n) => (typeof n === "number" && isFinite(n)) ? n.toFixed(1) + "%" : "—";
  const age = (ts) => {
    if (!ts) return "never";
    const s = (Date.now() - ts) / 1000;
    return s < 1 ? "now" : s < 60 ? Math.round(s) + "s" : Math.round(s / 60) + "m";
  };

  // ------------------------------------------------------------- freshness
  function mark(key) {
    const el = $("fresh-" + key);
    if (!el) return;
    if (state.lastError[key]) {
      el.textContent = "down";
      el.className = "pill down";
      el.title = state.lastError[key];
    } else {
      el.textContent = age(state.lastOk[key]);
      el.className = "pill ok";
      el.title = "last successful poll";
    }
  }

  // --------------------------------------------------------------- panels
  function renderSynaptic() {
    const s = state.synaptic;
    if (!s || !s.ok) {
      $("syn-nodes").textContent = "—";
      $("syn-dot").className = "dot bad";
      return;
    }
    $("syn-dot").className = "dot ok";
    $("syn-nodes").textContent = nf(s.nodes);
    $("syn-steps").textContent = nf(s.steps);
    $("syn-backend").textContent = (s.backend || "—").replace("torch.", "");
    $("syn-mean").textContent = nf(s.mean_state, 5);
    const sy = s.synapses || {};
    $("syn-edges").textContent = nf(sy.edges);
    $("syn-recip").textContent = sy.reciprocal_directed_frac != null
      ? pct(sy.reciprocal_directed_frac * 100) : "—";
    $("syn-inhib").textContent = sy.inhibitory_edge_frac != null
      ? pct(sy.inhibitory_edge_frac * 100) : "—";
    $("syn-mod").textContent = sy.modulator_total != null
      ? nf(sy.modulator_total, 3) : "—";
    $("syn-seal").textContent = (s.primal_seal || "").slice(0, 16) || "—";
    const f = s.fly || {};
    $("fly-neurons").textContent = nf(f.neurons);
    $("fly-synapses").textContent = nf(f.synapses);
    $("fly-neuropils").textContent = nf(f.neuropils);
  }

  function renderBrain() {
    const b = state.brain;
    if (!b || !b.ok) {
      $("bx-units").textContent = "—";
      $("bx-dot").className = "dot bad";
      return;
    }
    $("bx-dot").className = "dot ok";
    const units = b.units || [];
    $("bx-units").textContent = nf(units.length);
    const kinds = {};
    units.forEach((u) => { kinds[u.kind] = (kinds[u.kind] || 0) + 1; });
    $("bx-classes").textContent = nf(Object.keys(kinds).length);
    $("bx-tension").textContent = nf(b.tension, 4);
    $("bx-spread").textContent = nf((b.summary || {}).radial_spread, 5);
    $("bx-device").textContent = b.device || "—";

    const d = b.dna || {};
    $("dna-bases").textContent = d.bases || "—";
    $("dna-gen").textContent = nf(d.generation);
    $("dna-seed").textContent = (d.seed_hex || "—").slice(0, 16);
    $("dna-mut").textContent = d.mutated ? "mutation" : "stable";
    $("dna-mut").className = d.mutated ? "val warn" : "val";

    const l = b.learning || {};
    $("lrn-steps").textContent = nf(l.steps);
    $("lrn-mse").textContent = l.mse_ema != null
      ? Number(l.mse_ema).toExponential(2) : "—";
    $("lrn-gain").textContent = (l.gain && l.gain.length)
      ? nf(l.gain[0], 4) : "—";

    // unit table: top movers by velocity then by norm
    const rows = units.map((u) => ({
      kind: u.kind, name: u.name,
      vel: (u.meta && u.meta.velocity) || 0,
      chroma: (u.meta && u.meta.chroma) || "#666",
      norm: Math.sqrt(u.vec.reduce((a, v) => a + v * v, 0)),
    })).sort((a, b2) => b2.vel - a.vel || b2.norm - a.norm).slice(0, 14);

    $("unit-rows").innerHTML = rows.map((r) =>
      '<tr><td><i class="sw" style="background:' + r.chroma + '"></i>' +
      '<span class="k">' + r.kind + '</span></td>' +
      "<td class=\"nm\">" + r.name.replace(/</g, "&lt;").slice(0, 34) + "</td>" +
      "<td class=\"num\">" + r.norm.toFixed(4) + "</td>" +
      "<td class=\"num\">" + (r.vel ? r.vel.toFixed(4) : "—") + "</td></tr>"
    ).join("");
  }

  function renderStress() {
    const s = state.stress;
    const box = $("rule-rows");
    if (!s || !s.ok === undefined || !(s.rules || []).length) {
      box.innerHTML = '<div class="empty">no constraint data</div>';
      return;
    }
    box.innerHTML = s.rules.map((r) => {
      const bad = !r.ok;
      const v = (typeof r.value === "number") ? r.value.toFixed(1) : r.value;
      return '<div class="rule' + (bad ? " bad" : "") + '">' +
        '<span class="rn">' + r.name + "</span>" +
        '<span class="rv">' + v + " / " + r.limit + "</span>" +
        '<span class="rw">' + (r.why || "") + "</span></div>";
    }).join("");
    const bad = s.rules.filter((r) => !r.ok).length;
    $("stress-state").textContent = bad ? bad + " breach" : "within limits";
    $("stress-state").className = bad ? "val warn" : "val ok";
  }

  function renderActions() {
    const a = state.actions;
    const box = $("act-rows");
    if (!a || !(a.actions || []).length) {
      box.innerHTML = '<div class="empty">no actions</div>';
      return;
    }
    box.innerHTML = a.actions.map((x) =>
      '<div class="act" data-name="' + x.name + '">' +
      '<label class="chk"><input type="checkbox" id="ap-' + x.name + '"> apply</label>' +
      '<button type="button" class="run" data-name="' + x.name + '">' + x.name + "</button>" +
      '<span class="risk' + (x.mutates ? " warn" : "") + '">' + x.risk + "</span>" +
      '<div class="why">' + (x.why || "") + "</div>" +
      '<div class="out" id="out-' + x.name + '"></div></div>'
    ).join("");
    box.querySelectorAll(".run").forEach((b) => {
      b.addEventListener("click", () => runAction(b.dataset.name));
    });
  }

  async function runAction(name) {
    const chk = $("ap-" + name);
    const apply = !!(chk && chk.checked);
    const meta = ((state.actions || {}).actions || []).find((x) => x.name === name);
    const out = $("out-" + name);
    if (apply && meta && meta.mutates) {
      if (!window.confirm("Apply '" + name + "' to this machine?\n\n" + (meta.why || ""))) return;
    }
    out.textContent = "…";
    try {
      const r = await fetch(BRIDGE + "/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, apply }),
      });
      const j = await r.json();
      out.textContent = j.ok
        ? (j.applied ? "applied" : "simulated") +
          (j.result ? " · " + JSON.stringify(j.result).slice(0, 70) : "")
        : "refused: " + (j.reason || j.error || "denied");
    } catch (e) {
      out.textContent = "error: " + ((e && e.message) || e);
    }
  }

  function renderDownloads() {
    const d = state.downloads || {};
    const dot = $("dl-dot");
    if (dot) dot.className = "dot " + (d.available ? "ok" : "bad");
    const ver = $("dl-ver");
    if (ver) ver.textContent = d.version || "";

    const jobs = (d.jobs || []).slice().reverse();
    $("dl-rows").innerHTML = jobs.length
      ? jobs.map((j) => {
          const st = j.state || "?";
          const cls = st === "done" ? "ok" : (st === "failed" || st === "capped") ? "bad" : "";
          const mib = ((j.bytes || 0) / 1048576).toFixed(2);
          const rate = j.mib_s != null ? j.mib_s + " MiB/s" : "";
          return '<div class="proc"><span class="pp">' + st + "</span>" +
            '<span class="' + cls + '">' + String(j.name || "").slice(0, 34) +
            '</span><span class="pm">' + mib + " MiB " + rate + "</span></div>";
        }).join("")
      : '<div class="empty">no downloads</div>';
  }

  async function startDownload() {
    const url = ($("dl-url").value || "").trim();
    const cap = parseInt($("dl-cap").value || "64", 10);
    const out = $("dl-out");
    if (!url) { out.textContent = "enter a URL"; return; }
    out.textContent = "starting…";
    try {
      const r = await fetch(BRIDGE + "/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, max_mb: cap }),
      });
      const j = await r.json();
      out.textContent = j.ok ? "started " + (j.id || "") : "refused: " + (j.error || "");
      $("dl-url").value = "";
      tick();
    } catch (e) {
      out.textContent = "error: " + ((e && e.message) || e);
    }
  }

  function renderGpu() {
    const g = state.gpu || {};
    const nv = g.nvidia || {};
    const amd = g.amd || {};
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };

    set("gpu-dot", "");
    const dot = $("gpu-dot");
    if (dot) dot.className = "dot " + (g.ok ? "ok" : "bad");

    set("nv-name", nv.name || "—");
    set("nv-util", nv.util_pct != null ? nv.util_pct.toFixed(0) : "—");
    set("nv-temp", nv.temp_c != null ? nv.temp_c + " °C" : "—");
    set("nv-sm", nv.clock_sm != null ? nv.clock_sm + " MHz" : "—");
    set("nv-vram", (nv.vram_used_mib != null && nv.vram_total_mib != null)
      ? (nv.vram_used_mib / 1024).toFixed(2) + " / " +
        (nv.vram_total_mib / 1024).toFixed(2) + " GiB" : "—");
    set("nv-pcie", nv.pcie_gen ? "gen" + nv.pcie_gen + " ×" + nv.pcie_width : "—");
    set("nv-eng", (nv.enc_pct != null || nv.dec_pct != null)
      ? nv.enc_pct + " / " + nv.dec_pct : "—");
    set("nv-pwr", nv.power_w != null ? nv.power_w + " W" : "—");

    set("amd-name", amd.name || "—");
    set("amd-mode", amd.mode || "—");
    set("amd-drv", amd.driver || "—");
    set("amd-hz", amd.refresh_hz != null ? amd.refresh_hz + " Hz" : "—");
    set("amd-ctr", amd.counters ? "nvml" : "wmi only");
    set("amd-note", amd.note || "—");

    const procs = nv.processes || [];
    $("gpu-procs").innerHTML = procs.length
      ? procs.map((p) => '<div class="proc"><span class="pp">' + p.pid +
          "</span>" + String(p.name || "").replace(/</g, "&lt;").slice(-46) +
          '<span class="pm">' + (p.vram || "") + "</span></div>").join("")
      : '<div class="empty">no compute processes</div>';
  }

  function renderModels() {
    const m = state.models;
    const box = $("model-rows");
    if (!m || !(m.data || []).length) {
      const why = (m && m.error) ? m.error + (m.hint ? " · " + m.hint : "")
        : "model server offline";
      box.innerHTML = '<div class="empty">' + why + "</div>";
      $("model-count").textContent = "0";
      return;
    }
    const rows = m.data.slice(0, 40);
    box.innerHTML = rows.map((x) =>
      '<div class="mrow"><span class="mid">' +
      String(x.id || x.name || "?").replace(/</g, "&lt;") + "</span>" +
      '<span class="march">' + (x.arch || "") + "</span></div>"
    ).join("");
    $("model-count").textContent = m.data.length + " loaded/known";
  }

  function renderServices() {
    const up = (k) => !state.lastError[k];
    const rows = [
      ["runtime :8790", up("synaptic")],
      ["bridge :8791", up("brain")],
      ["gateway :9001", up("syn")],
      ["models :1234", up("models")],
    ];
    $("svc-rows").innerHTML = rows.map(([n, ok]) =>
      '<div class="svc"><span class="dot ' + (ok ? "ok" : "bad") + '"></span>' +
      "<span>" + n + "</span><b>" + (ok ? "up" : "down") + "</b></div>"
    ).join("");
  }

  // ----------------------------------------------------------------- tick
  async function tick() {
    state.polls++;
    await Promise.all([
      poll("syn", GATEWAY + "/brain/state", (v) => { state.synaptic = v; }, 6000),
      poll("brain", BRIDGE + "/api/brain", (v) => { state.brain = v; }, 30000),
      poll("stress", BRIDGE + "/api/stress", (v) => { state.stress = v; }, 12000),
      poll("actions", BRIDGE + "/api/actions", (v) => { state.actions = v; }, 10000),
      poll("models", BRIDGE + "/api/models", (v) => { state.models = v; }, 12000),
      poll("gpu", BRIDGE + "/api/gpu", (v) => { state.gpu = v; }, 8000),
      poll("dl", BRIDGE + "/api/downloads", (v) => { state.downloads = v; }, 8000),
    ]);

    renderSynaptic();
    renderBrain();
    renderStress();
    renderActions();
    renderModels();
    renderGpu();
    renderDownloads();
    renderServices();

    ["syn", "brain", "stress", "actions", "models", "gpu"].forEach(mark);
    mark("dl");
    $("poll-count").textContent = state.polls;
    $("last-tick").textContent = new Date().toLocaleTimeString();
  }

  // ----------------------------------------------------------------- boot
  function boot() {
    $("refresh").addEventListener("click", tick);
    $("dl-go").addEventListener("click", startDownload);
    $("dl-url").addEventListener("keydown", (e) => {
      if (e.key === "Enter") startDownload();
    });
    tick();
    setInterval(tick, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
