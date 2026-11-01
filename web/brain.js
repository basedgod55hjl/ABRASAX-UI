/* ABRASAX brain panel — Monitor surface.
 * Reads /brain/state + /brain/texture + /metrics, posts /brain/step.
 * Gateway :9001 proxies the brain; :9626 is the standalone fallback.
 *
 * Kept deliberately small: no framework, no build step, one 64x64 texture,
 * a 60-sample mean_state ring buffer in memory, and the gateway's Prometheus
 * exposition parsed as text (no vram/disk gauge exists there today, so those
 * cells say "—" until one is exported rather than inventing a number).
 */
(() => {
  "use strict";

  const GW = location.protocol === "file:" ? "http://127.0.0.1:9001" : "";
  const CANDIDATES = [GW, "http://127.0.0.1:9001", "http://127.0.0.1:9626"].filter((v, i, a) => v !== undefined && a.indexOf(v) === i);
  const HISTORY_MAX = 60;
  const STATE_MS = 10000;   // sparkline keeps sampling with the panel closed
  const PANEL_MS = 5000;    // texture + stats while the panel is visible

  let base = null;
  let panelTimer = null;
  let inflight = false;
  let flyCache = null;

  const meanHistory = [];   // last 60 mean_state samples, oldest → newest

  const $ = (id) => document.getElementById(id);
  const panel = $("brainPanel");
  const canvas = $("brainCanvas");
  const ctx = canvas ? canvas.getContext("2d") : null;
  const spark = $("brainSpark");
  const sctx = spark ? spark.getContext("2d") : null;

  const fmt = (n) => (typeof n === "number" && isFinite(n) ? n.toLocaleString() : "—");

  function fmtCompact(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
    return n.toLocaleString();
  }

  function fmtDuration(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds)) return "—";
    if (seconds < 60) return seconds.toFixed(1) + " s";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds / 60) % 60;
    if (h) return h + "h " + String(m).padStart(2, "0") + "m";
    return m + "m " + String(Math.floor(seconds % 60)).padStart(2, "0") + "s";
  }

  async function jget(path, ms = 6000) {
    const bases = base ? [base, ...CANDIDATES.filter((b) => b !== base)] : CANDIDATES;
    let lastErr;
    for (const b of bases) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms);
        const r = await fetch(b + path, { signal: ctl.signal, cache: "no-store" });
        clearTimeout(t);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        base = b;
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("brain unreachable");
  }

  async function jtext(path, ms = 6000) {
    const b = base || CANDIDATES[0];
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(b + path, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }

  async function jpost(path, body, ms = 20000) {
    const b = base || CANDIDATES[0];
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(b + path, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /* ---------------- textures ---------------- */

  function draw(texture) {
    if (!ctx || !texture || !texture.data) return;
    const n = texture.size || 64;
    const raw = atob(texture.data);
    const img = ctx.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const v = raw.charCodeAt(i) & 0xff;
      // violet → cyan ramp on near-black, matching the shell palette
      img.data[i * 4 + 0] = Math.round(20 + v * 0.42);
      img.data[i * 4 + 1] = Math.round(8 + v * 0.72);
      img.data[i * 4 + 2] = Math.round(40 + v * 0.84);
      img.data[i * 4 + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = n; tmp.height = n;
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }

  /* ---------------- sparkline ---------------- */

  // Inline colours mirror styles.css :root (canvas cannot read custom properties
  // without getComputedStyle on every frame, which is not worth it here).
  const C = { line: "#7c6cf0", fill: "rgba(124,108,240,0.14)", grid: "#23233a", text: "#7d7d94" };

  function pushSample(v) {
    if (typeof v !== "number" || !isFinite(v)) return;
    meanHistory.push(v);
    while (meanHistory.length > HISTORY_MAX) meanHistory.shift();
  }

  function drawSpark() {
    if (!spark || !sctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(120, Math.round(spark.clientWidth || 190));
    const cssH = Math.max(20, Math.round(spark.clientHeight || 32));
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (spark.width !== bw || spark.height !== bh) {
      spark.width = bw;
      spark.height = bh;
    }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, cssW, cssH);

    // hairline grid — 25/50/75 %
    sctx.strokeStyle = C.grid;
    sctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((cssH * i) / 4) + 0.5;
      sctx.beginPath();
      sctx.moveTo(0, y);
      sctx.lineTo(cssW, y);
      sctx.stroke();
    }

    const n = meanHistory.length;
    if (!n) return;

    let lo = Math.min(...meanHistory);
    let hi = Math.max(...meanHistory);
    // A nearly flat series would otherwise sit on the frame edge; give it a
    // minimum 0.002 domain so small drift is still readable. The min/max text
    // below the spark always reports the true values.
    if (hi - lo < 0.002) {
      const mid = (hi + lo) / 2;
      lo = mid - 0.001;
      hi = mid + 0.001;
    }
    const pad = 3;
    const h = cssH - pad * 2;
    const x = (i) => (n === 1 ? cssW - pad : pad + (i * (cssW - pad * 2)) / (n - 1));
    const y = (v) => pad + h - ((v - lo) / (hi - lo)) * h;

    // area under the trace
    sctx.beginPath();
    sctx.moveTo(x(0), cssH);
    for (let i = 0; i < n; i++) sctx.lineTo(x(i), y(meanHistory[i]));
    sctx.lineTo(x(n - 1), cssH);
    sctx.closePath();
    sctx.fillStyle = C.fill;
    sctx.fill();

    // trace
    sctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0) sctx.moveTo(x(i), y(meanHistory[i]));
      else sctx.lineTo(x(i), y(meanHistory[i]));
    }
    sctx.strokeStyle = C.line;
    sctx.lineWidth = 1.5;
    sctx.lineJoin = "round";
    sctx.stroke();

    // newest sample marker
    sctx.beginPath();
    sctx.arc(x(n - 1), y(meanHistory[n - 1]), 2, 0, Math.PI * 2);
    sctx.fillStyle = C.line;
    sctx.fill();
  }

  function renderSpark() {
    const last = meanHistory.length ? meanHistory[meanHistory.length - 1] : null;
    setText("brainSparkVal", last == null ? "—" : last.toFixed(4));
    if (meanHistory.length) {
      const lo = Math.min(...meanHistory);
      const hi = Math.max(...meanHistory);
      setText("brainSparkRange", "min " + lo.toFixed(4) + " · max " + hi.toFixed(4));
    }
    drawSpark();
  }

  /* ---------------- gateway /metrics (Prometheus text) ---------------- */

  // One parser for the whole exposition: name{labels} value, comments skipped.
  function parseMetrics(text) {
    const out = Object.create(null);
    const re = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*$/;
    text.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t || t.charAt(0) === "#") return;
      const m = re.exec(t);
      if (!m) return;
      const v = Number(m[3]);
      if (!isFinite(v)) return;
      if (!(m[1] in out)) out[m[1]] = { value: v, labels: m[2] || "" }; // first sample wins
    });
    return out;
  }

  function findGauge(map, re) {
    for (const name of Object.keys(map)) {
      if (re.test(name)) return { name, value: map[name].value };
    }
    return null;
  }

  function fmtGauge(name, value) {
    if (/_bytes$/.test(name) && Math.abs(value) >= 1e6) return (value / 1073741824).toFixed(1) + " GiB";
    if (/_mb$/.test(name)) return Math.round(value).toLocaleString() + " MB";
    if (/_seconds$/.test(name)) return fmtDuration(value);
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  async function renderMetrics() {
    try {
      const map = parseMetrics(await jtext("/metrics"));

      const up = map["abrasax_gateway_uptime_seconds"];
      setText("brainUptime", up ? fmtDuration(up.value) : "—");

      const vram = findGauge(map, /vram|gpu_mem|gpu_memory/i);
      const vramEl = $("brainVram");
      if (vramEl) {
        vramEl.textContent = vram ? fmtGauge(vram.name, vram.value) : "—";
        vramEl.title = vram ? vram.name : "no vram gauge exported by /metrics yet";
      }

      const disk = findGauge(map, /disk.*(free|avail|space)|(free|avail).*disk/i);
      const diskEl = $("brainDisk");
      if (diskEl) {
        diskEl.textContent = disk ? fmtGauge(disk.name, disk.value) : "—";
        diskEl.title = disk ? disk.name : "no disk gauge exported by /metrics yet";
      }

      const src = document.querySelector(".brain-meter-src");
      if (src) {
        src.textContent = ":9001/metrics";
        src.title = Object.keys(map).length + " series parsed";
      }
    } catch (e) {
      // Metrics are decoration next to the field; never turn this into a panel error.
      const src = document.querySelector(".brain-meter-src");
      if (src) src.title = "metrics unavailable: " + (e && e.message ? e.message : e);
    }
  }

  /* ---------------- render ---------------- */

  function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

  function renderState(s) {
    const syn = s.synapses || {};
    setText("brainDotState", "live");
    const dot = $("brainDot"); if (dot) dot.className = "dot ok";
    setText("brainBackend", s.backend || "—");
    setText("brainSteps", fmt(s.steps));
    setText("brainNodes", fmt(s.nodes));
    setText("brainSynapses", fmt(syn.edges));
    setText("brainRecip", syn.reciprocal_directed_frac != null ? syn.reciprocal_directed_frac.toFixed(3) : "—");
    setText("brainInhib", syn.inhibitory_edge_frac != null ? syn.inhibitory_edge_frac.toFixed(3) : "—");
    setText("brainHubs", syn.top_cell_frac_for_50pct_of_synapses != null ? syn.top_cell_frac_for_50pct_of_synapses.toFixed(3) : "—");
    setText("brainMod", syn.modulator_total != null ? syn.modulator_total.toFixed(3) : "—");
    setText("brainMean", s.mean_state != null ? s.mean_state.toFixed(4) : "—");
    setText("brainSha", (s.grid_sha256 || "").slice(0, 12));
    setText("brainPersisted", s.persisted ? "persisted" : "unsaved");

    pushSample(s.mean_state);
    renderSpark();

    if (s.fly) renderFly(s.fly);
    else if (!flyCache) ensureFly();
  }

  function renderFly(fly) {
    if (!fly) return;
    flyCache = fly;
    if (fly.neurons != null) setText("flyNeurons", fmt(fly.neurons));
    if (fly.synapses != null) setText("flySynapses", fmtCompact(fly.synapses));
    if (fly.reciprocal_directed_frac != null) setText("flyRecip", fly.reciprocal_directed_frac.toFixed(3));
  }

  async function ensureFly() {
    try { renderFly(await jget("/brain/fly")); } catch (e) { /* static HTML values stay */ }
  }

  async function tick(full) {
    if (inflight) return;
    inflight = true;
    try {
      const s = await jget("/brain/state");
      renderState(s);
      if (full) {
        const t = await jget("/brain/texture");
        draw(t);
        await renderMetrics();
      }
      setText("brainError", "");
    } catch (e) {
      const dot = $("brainDot"); if (dot) dot.className = "dot bad";
      setText("brainDotState", "offline");
      setText("brainError", String(e && e.message ? e.message : e));
    } finally {
      inflight = false;
    }
  }

  async function step(n) {
    const btn = $("brainStep" + n); if (btn) btn.disabled = true;
    try { await jpost("/brain/step", { n, learn: true }); await tick(true); }
    catch (e) { setText("brainError", String(e && e.message ? e.message : e)); }
    finally { if (btn) btn.disabled = false; }
  }

  function open() {
    panel.hidden = false;
    document.body.classList.add("brain-open");
    const toggle = $("toggleBrain");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    tick(true);
    if (!panelTimer) panelTimer = setInterval(() => tick(true), PANEL_MS);
  }

  function close() {
    panel.hidden = true;
    document.body.classList.remove("brain-open");
    const toggle = $("toggleBrain");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    if (panelTimer) { clearInterval(panelTimer); panelTimer = null; }
  }

  // Debug handle for smoke tests (mirrors window.AbrasaXUI).
  window.AbrasaBrain = {
    samples: () => meanHistory.slice(),
    refresh: () => tick(true),
  };

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = $("toggleBrain");
    if (toggle) toggle.addEventListener("click", () => (panel.hidden ? open() : close()));
    const closeBtn = $("brainClose"); if (closeBtn) closeBtn.addEventListener("click", close);
    const s1 = $("brainStep1"); if (s1) s1.addEventListener("click", () => step(1));
    const s25 = $("brainStep25"); if (s25) s25.addEventListener("click", () => step(25));
    const rf = $("brainRefresh"); if (rf) rf.addEventListener("click", () => tick(true));

    drawSpark();
    tick(true);                          // warm the dot + first sparkline sample
    setInterval(() => tick(false), STATE_MS);

    // The panel can be opened before the first texture arrives; keep the
    // canvas crisp when the viewport (and therefore panel width) changes.
    window.addEventListener("resize", drawSpark, { passive: true });
  });
})();
