/* BX_CHROMA */
/* BX_DEEP */
/* ==========================================================================
   ABRASAX 7-D brain map renderer
   --------------------------------------------------------------------------
   Reads GET /api/brain (+ /api/stress) from the abxu bridge and draws the
   machine's units as nodes inside the Poincare ball.

   Projection: the 7 axes are reduced to 3 screen axes by a fixed, documented
   basis. Axes 0-2 (load/thermal/memory) drive X, 3-5 (throughput/latency/
   coherence) drive Y, and axis 6 (burst) drives Z. Z is rendered as size +
   opacity so nothing is invented and the mapping is inspectable.

   No framework, no build step. Palette follows unified.css.
   ========================================================================== */
(() => {
  "use strict";

  const POLL_MS = 3000;
  const KIND_COLOUR = {
    "cpu-core": "#7c6cf0",
    "gpu": "#4fd1c5",
    "gpu-sm": "#38bdf8",
    "gpu-mem": "#a78bfa",
    "gpu-pcie": "#fbbf24",
    "gpu-power": "#fb7185",
    "dimm": "#c9a6ff",
    "memory": "#ffd479",
    "disk": "#8f8fb0",
    "disk-dev": "#6f6f8f",
    "process": "#ff6b9d",
    "service": "#55d98a",
    "gpu-adapter": "#f472b6",
    "gpu-igpu": "#e879f9",
    "igpu-display": "#c084fc",
    "igpu-driver": "#a855f7",
    "model": "#22d3ee",
  };

  const $ = (id) => document.getElementById(id);
  const cvs = $("bxCanvas");
  if (!cvs) return;
  const ctx = cvs.getContext("2d");

  let base = null;
  let data = null;
  let stress = null;
  let rot = 0.0;
  let paused = false;
  let lastErr = "";

  // ---------- API ----------
  async function jget(path, ms = 8000) {
    const bases = base ? [base] : ["", "http://127.0.0.1:8791"];
    let err;
    for (const b of bases) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms);
        const r = await fetch(b + path, { signal: ctl.signal, cache: "no-store" });
        clearTimeout(t);
        if (!r.ok) throw new Error("HTTP " + r.status);
        base = b;
        return await r.json();
      } catch (e) { err = e; }
    }
    throw err;
  }

  async function poll() {
    try {
      data = await jget("/api/brain");
      try { stress = await jget("/api/stress"); } catch (e) { stress = null; }
      lastErr = "";
      $("bxDot").className = "dot ok";
      $("bxState").textContent = "live";
    } catch (e) {
      lastErr = String(e && e.message || e);
      $("bxDot").className = "dot bad";
      $("bxState").textContent = "offline";
    }
    render();
  }

  // ---------- projection ----------
  // Map the 7-D unit vector onto 3 screen-space coordinates.
  function project(v, w, h) {
    const [a0, a1, a2, a3, a4, a5, a6] = v;
    const x = (a0 - a2) * 0.5;                    // load vs memory
    const y = (a3 - a4) * 0.5;                    // throughput vs latency
    const z = (a1 + a5) * 0.5;                    // thermal + coherence
    const R = Math.min(w, h) * 0.42;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    const persp = 1 / (1.55 - z * 0.55);
    return {
      px: w / 2 + rx * R * persp,
      py: h / 2 + ry * R * persp,
      depth: z,
      scale: persp,
      burst: a6,
    };
  }

  function fit() {
    const r = cvs.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = Math.max(1, Math.round(r.width * dpr));
    cvs.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: r.width, h: r.height };
  }

  // ---------- draw ----------
  function render() {
    const { w, h } = fit();
    ctx.clearRect(0, 0, w, h);
    if (!data || !data.ok) {
      ctx.fillStyle = "#6e6e90";
      ctx.font = "12px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("brain offline — " + (lastErr || "no data"), w / 2, h / 2);
      return;
    }

    const units = (data.units || []);
    const R = Math.min(w, h) * 0.42;
    const cx = w / 2, cy = h / 2;

    // ball boundary
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.06, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(124,108,240,.22)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // concentric rings = distance from the calm centre
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * 1.06) * (i / 4), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(124,108,240,.08)";
      ctx.stroke();
    }

    // axes crosshair
    ctx.strokeStyle = "rgba(124,108,240,.10)";
    ctx.beginPath();
    ctx.moveTo(cx - R * 1.06, cy); ctx.lineTo(cx + R * 1.06, cy);
    ctx.moveTo(cx, cy - R * 1.06); ctx.lineTo(cx, cy + R * 1.06);
    ctx.stroke();

    // order back-to-front so nearer nodes overdraw
    // Paint order: parent classes first, specific sub-parts last, so a small
    // node is never buried under a large one. Depth still orders within a class.
    const RANK = { "gpu": 0, "gpu-sm": 1, "gpu-mem": 2, "gpu-pcie": 2,
                   "gpu-power": 2 };
    const rank = (k) => (RANK[k] === undefined ? 0 : RANK[k]);
    const pts = units.map((u, i) => ({ u, i, p: project(u.vec, w, h) }))
      .sort((A, B) => {
        const ra = rank(A.u.kind), rb = rank(B.u.kind);
        if (ra !== rb) return ra - rb;          // parents before sub-parts
        return A.p.depth - B.p.depth;
      });

    for (const { u, p } of pts) {
      // ABS/XOR chroma key when the payload supplies one (stable per unit),
      // else fall back to the class colour.
      const colour = (u.meta && u.meta.chroma) || KIND_COLOUR[u.kind] || "#8f8fb0";
      const vel = (u.meta && u.meta.velocity) || 0;
      const rad = 3.0 + Math.min(1, vel * 2.5) * 8.0;
      const alpha = 0.34 + 0.62 * Math.min(1, p.scale);

      ctx.beginPath();
      ctx.arc(p.px, p.py, rad, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.globalAlpha = alpha;
      ctx.fill();

      // a hot node glows
      if (u.vec[0] > 0.75 || u.vec[2] > 0.9) {
        ctx.beginPath();
        ctx.arc(p.px, p.py, rad * 2.1, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.globalAlpha = 0.10;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // label the GPU and any service that is down
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    for (const { u, p } of pts) {
      const hot = u.kind === "gpu" || (u.kind === "service" && u.meta && !u.meta.up);
      if (!hot) continue;
      ctx.fillStyle = u.meta && u.meta.up === false ? "#ff7a7a" : "#9fe8e0";
      const label = u.kind === "gpu" ? "GPU" : u.name;
      ctx.fillText(label, p.px + 7, p.py + 3);
    }

    updateLegend(pts);
    updateRail();
    $("bxHud").innerHTML =
      "units <b>" + units.length + "</b> · tension <b>" +
      (data.tension == null ? "—" : data.tension.toFixed(4)) +
      "</b> · " + (data.device || "?") +
      " · sample <b>" + (data.sample_ms == null ? "—" : data.sample_ms + "ms") + "</b>";
    $("bxDeg").dataset.on = data.summary && data.summary.degenerate ? "1" : "0";
  }

  function updateLegend(pts) {
    const el = document.querySelector(".bx-legend");
    if (!el || !pts || !pts.length) return;
    const kinds = [...new Set(pts.map((p) => p.u.kind))].sort();
    const sig = kinds.join(",");
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = kinds.map((k) =>
      '<span><i style="background:' + (KIND_COLOUR[k] || "#888") + '"></i>' +
      k + '</span>').join("");
  }

  function updateLearning() {
    const L = (data && data.learning) || {};
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set("bxLearnSteps", L.steps == null ? "—" : L.steps);
    set("bxLearnMse", L.mse_ema == null ? "—" : Number(L.mse_ema).toExponential(2));
    set("bxLearnGain", (L.gain && L.gain.length) ? L.gain[0] : "—");
    const st = $("bxLearnState");
    if (st) {
      st.textContent = L.steps ? "learning" : "cold";
      st.className = "sub " + (L.steps ? "ok" : "");
    }
  }

  function updateRail() {
    if (!data || !data.ok) return;
    const s = data.summary || {};
    $("bxCount").textContent = s.count ?? "—";
    $("bxSpread").textContent = s.radial_spread ?? "—";
    $("bxDevice").textContent = data.device ?? "—";
    $("bxSamples").textContent = data.samples ?? "—";

    const t = data.tension == null ? 0 : data.tension;
    $("bxTensionFill").style.width = Math.max(0, Math.min(100, t * 100)) + "%";
    $("bxTensionVal").textContent = t.toFixed(4);

    // constraint rules
    const box = $("bxRules");
    if (stress && stress.rules) {
      box.innerHTML = stress.rules.map((r) => {
        const bad = !r.ok;
        const val = (typeof r.value === "number") ? r.value.toFixed ? r.value.toFixed(1) : r.value : r.value;
        return '<div class="bx-rule' + (bad ? " bad" : "") + '">' +
          '<span class="n">' + r.name + '</span>' +
          '<span class="v">' + val + " / " + r.limit + '</span>' +
          '<span class="w">' + (r.why || "") + '</span></div>';
      }).join("");
      $("bxStressOk").textContent = stress.ok ? "within limits" : "BREACH";
      $("bxStressOk").className = stress.ok ? "ok" : "bad";
    } else {
      box.innerHTML = '<div class="bx-empty">no stress data</div>';
    }

    updateLearning();

    // bursts
    const b = data.bursts || [];
    const val = (x) => {
      const v = (x.velocity !== undefined) ? x.velocity : x.delta;
      return (typeof v === "number" && isFinite(v)) ? v.toFixed(5) : "—";
    };
    $("bxBursts").innerHTML = b.length
      ? b.map((x) => '<div class="bx-burst"><span>' + x.name +
          '</span><b>' + val(x) + '</b></div>').join("")
      : '<div class="bx-empty">no movement yet</div>';
  }

  // ---------- interaction ----------
  let dragging = false, lastX = 0;
  cvs.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; cvs.setPointerCapture(e.pointerId);
  });
  cvs.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    rot += (e.clientX - lastX) * 0.008;
    lastX = e.clientX;
    render();
  });
  cvs.addEventListener("pointerup", () => { dragging = false; });
  cvs.addEventListener("pointerleave", () => { dragging = false; });

  $("bxPause").addEventListener("click", () => {
    paused = !paused;
    $("bxPause").textContent = paused ? "Resume" : "Pause";
  });

  // ---------- loop ----------
  function spin() {
    if (!paused && !dragging) rot += 0.0016;
    render();
    requestAnimationFrame(spin);
  }



  // ---------------- actuation controls (BX_ACTUATE_CLEAN) ----------------
  let lastActions = [];

  async function loadActions() {
    try {
      const a = await jget("/api/actions");
      if (!a || !a.ok) return;
      lastActions = a.actions || [];
      const box = $("bxActions");
      box.innerHTML = lastActions.map((x) =>
        '<div class="bx-act">' +
          '<label class="bx-apply"><input type="checkbox" id="bxApply_' + x.name + '"> apply</label>' +
          '<button type="button" class="bx-runbtn" data-name="' + x.name + '">' + x.name + '</button>' +
          '<span class="bx-risk' + (x.mutates ? ' warn' : '') + '">' + x.risk + '</span>' +
          '<div class="bx-why">' + (x.why || '') + '</div>' +
          '<div class="bx-out" id="bxOut_' + x.name + '"></div>' +
        '</div>').join("");
      // delegated: one listener on the container, attached once (see below)
    } catch (e) { /* keep placeholder */ }
  }

  async function runAction(name) {
    const chk = $("bxApply_" + name);
    const apply = !!(chk && chk.checked);
    const meta = lastActions.find((x) => x.name === name);
    const out = $("bxOut_" + name);
    if (apply && meta && meta.mutates) {
      if (!window.confirm("Apply '" + name + "' to this machine?\n\n" + (meta.why || ""))) return;
    }
    out.textContent = "…";
    try {
      const r = await fetch((base || "") + "/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, apply: apply }),
      });
      const j = await r.json();
      if (j.ok) {
        out.textContent = (j.applied ? "applied" : "simulated") +
          (j.result ? " · " + JSON.stringify(j.result).slice(0, 80) : "");
        $("bxActState").textContent = j.applied ? "live edits on" : "simulated";
        $("bxActState").className = "sub " + (j.applied ? "ok" : "");
      } else {
        out.textContent = "refused: " + (j.reason || j.error || "denied");
      }
    } catch (e) {
      out.textContent = "error: " + (e && e.message || e);
    }
  }

  // BX_DELEGATED: one listener for all action buttons, attached to the stable
  // container so re-rendering innerHTML never orphans a handler.
  (function bindActions() {
    const box = $("bxActions");
    if (!box || box.dataset.bound === "1") return;
    box.dataset.bound = "1";
    box.addEventListener("click", (ev) => {
      const btn = ev.target.closest ? ev.target.closest(".bx-runbtn") : null;
      if (!btn) return;
      ev.preventDefault();
      runAction(btn.dataset.name);
    });
  })();

  poll();
  loadActions();
  setInterval(poll, POLL_MS);
  spin();
  window.addEventListener("resize", () => render());
})();
