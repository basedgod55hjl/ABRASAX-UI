"""Add the dual-GPU panel to the console UI (AMD + NVIDIA visual parts)."""
from __future__ import annotations

import io
import sys

HTML = r"C:\ABRASAX\UI\abrasax-ui\web\console\index.html"
JS = r"C:\ABRASAX\UI\abrasax-ui\web\console\console.js"

PANEL = '''  <!-- dual GPU -->
  <section class="card" style="grid-column: span 2; min-width:0">
    <h2><span class="dot" id="gpu-dot"></span>gpus · amd + nvidia
      <span class="pill" id="fresh-gpu">—</span></h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div class="gtitle">NVIDIA</div>
        <div class="big"><span id="nv-util">—</span><small>util %</small></div>
        <div class="row"><span class="k">name</span><span class="val" id="nv-name">—</span></div>
        <div class="row"><span class="k">temp</span><span class="val" id="nv-temp">—</span></div>
        <div class="row"><span class="k">sm clock</span><span class="val" id="nv-sm">—</span></div>
        <div class="row"><span class="k">vram</span><span class="val" id="nv-vram">—</span></div>
        <div class="row"><span class="k">pcie</span><span class="val" id="nv-pcie">—</span></div>
        <div class="row"><span class="k">enc / dec</span><span class="val" id="nv-eng">—</span></div>
        <div class="row"><span class="k">power</span><span class="val" id="nv-pwr">—</span></div>
      </div>
      <div>
        <div class="gtitle">AMD</div>
        <div class="big"><span id="amd-mode">—</span><small>display</small></div>
        <div class="row"><span class="k">name</span><span class="val" id="amd-name">—</span></div>
        <div class="row"><span class="k">driver</span><span class="val" id="amd-drv">—</span></div>
        <div class="row"><span class="k">refresh</span><span class="val" id="amd-hz">—</span></div>
        <div class="row"><span class="k">counters</span><span class="val" id="amd-ctr">—</span></div>
        <div class="note" id="amd-note">—</div>
      </div>
    </div>
    <div class="note">GPU compute processes</div>
    <div id="gpu-procs" class="procs"><div class="empty">—</div></div>
  </section>

'''

ANCHOR = '''  <!-- 5. unit table -->'''

JS_STATE = '''    brain: null, stress: null, actions: null, unity: null, info: null,
    synaptic: null, models: null,'''
JS_STATE_NEW = '''    brain: null, stress: null, actions: null, unity: null, info: null,
    synaptic: null, models: null, gpu: null,'''

JS_POLL = '      poll("models", BRIDGE + "/api/models", (v) => { state.models = v; }, 12000),'
JS_POLL_NEW = (JS_POLL + '\n'
               '      poll("gpu", BRIDGE + "/api/gpu", (v) => { state.gpu = v; }, 8000),')

JS_RENDER = '''
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
'''

JS_CALL = '''    renderServices();'''
JS_CALL_NEW = '''    renderGpu();
    renderServices();'''

JS_PILL = '''    ["syn", "brain", "stress", "actions", "models"].forEach(mark);'''
JS_PILL_NEW = '''    ["syn", "brain", "stress", "actions", "models", "gpu"].forEach(mark);'''


def main() -> int:
    h = io.open(HTML, encoding="utf-8").read()
    j = io.open(JS, encoding="utf-8").read()

    if "nv-util" in h:
        print("already added")
        return 0

    n = 0
    for old, new in ((ANCHOR, PANEL + ANCHOR),
                     (JS_STATE, JS_STATE_NEW),
                     (JS_POLL, JS_POLL_NEW),
                     (JS_CALL, JS_CALL_NEW),
                     (JS_PILL, JS_PILL_NEW)):
        if old in h:
            h = h.replace(old, new, 1); n += 1
        elif old in j:
            j = j.replace(old, new, 1); n += 1

    if "function renderGpu" not in j:
        j = j.replace("  function renderModels() {",
                      JS_RENDER.strip("\n") + "\n\n  function renderModels() {", 1)
        n += 1

    io.open(HTML, "w", encoding="utf-8", newline="\n").write(h)
    io.open(JS, "w", encoding="utf-8", newline="\n").write(j)
    print(f"gpu panel wired ({n} edits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
