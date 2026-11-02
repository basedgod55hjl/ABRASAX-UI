"""Add the aria2 download panel to the console UI."""
from __future__ import annotations

import io
import sys

HTML = r"C:\ABRASAX\UI\abrasax-ui\web\console\index.html"
JS = r"C:\ABRASAX\UI\abrasax-ui\web\console\console.js"

PANEL = '''  <!-- aria2 downloads -->
  <section class="card" style="grid-column: span 2; min-width:0">
    <h2><span class="dot" id="dl-dot"></span>aria2 downloads
      <span class="pill" id="fresh-dl">—</span>
      <span class="stat" id="dl-ver" style="margin-left:auto"></span></h2>
    <div class="dlrow">
      <input type="text" id="dl-url" placeholder="https://…  (http/https/ftp/magnet)"
             aria-label="Download URL">
      <input type="number" id="dl-cap" value="64" min="1" max="4096"
             title="Cap in MiB" aria-label="Cap MiB" class="cap">
      <button type="button" class="btn" id="dl-go">Fetch</button>
    </div>
    <div id="dl-out" class="dlout"></div>
    <div id="dl-rows" class="procs"><div class="empty">no downloads</div></div>
    <div class="note">Byte-capped per job (default 512 MiB), destination confined to
      C:\\ABRASAX\\DOWNLOADS, schemes limited to http/https/ftp/magnet.
      Every job is audited to LOGS/aria2_jobs.jsonl.</div>
  </section>

'''

ANCHOR = '''  <!-- 5. unit table -->'''

JS_STATE_OLD = '''    synaptic: null, models: null, gpu: null,'''
JS_STATE_NEW = '''    synaptic: null, models: null, gpu: null, downloads: null,'''

JS_POLL_OLD = '      poll("gpu", BRIDGE + "/api/gpu", (v) => { state.gpu = v; }, 8000),'
JS_POLL_NEW = (JS_POLL_OLD +
               '\n      poll("dl", BRIDGE + "/api/downloads", (v) => { state.downloads = v; }, 8000),')

JS_RENDER = '''
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
            "</span><span class=\"pm\">" + mib + " MiB " + rate + "</span></div>";
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
'''

JS_CALL_OLD = '''    renderGpu();
    renderServices();'''
JS_CALL_NEW = '''    renderGpu();
    renderDownloads();
    renderServices();'''

JS_PILL_OLD = '''    ["syn", "brain", "stress", "actions", "models", "gpu"].forEach(mark);'''
JS_PILL_NEW = '''    ["syn", "brain", "stress", "actions", "models", "gpu"].forEach(mark);
    mark("dl");'''

JS_BIND_OLD = '''    $("refresh").addEventListener("click", tick);'''
JS_BIND_NEW = '''    $("refresh").addEventListener("click", tick);
    $("dl-go").addEventListener("click", startDownload);
    $("dl-url").addEventListener("keydown", (e) => {
      if (e.key === "Enter") startDownload();
    });'''

CSS_ADD = '''

/* ---------- aria2 downloads ---------- */
.dlrow { display: flex; gap: 8px; margin-bottom: 8px; }
.dlrow input[type=text] {
  flex: 1; min-width: 0;
  background: #0d0d18; color: var(--ink);
  border: 1px solid var(--line); border-radius: 7px;
  padding: 7px 10px; font: 12px ui-monospace, Consolas, monospace;
}
.dlrow input.cap { width: 72px; text-align: right; }
.dlrow input:focus { outline: none; border-color: var(--acc); }
.dlout { font: 10.5px ui-monospace, monospace; color: var(--cyan); min-height: 16px; }
'''


def main() -> int:
    h = io.open(HTML, encoding="utf-8").read()
    j = io.open(JS, encoding="utf-8").read()
    css_path = r"C:\ABRASAX\UI\abrasax-ui\web\console\console.css"
    c = io.open(css_path, encoding="utf-8").read()

    if "dl-url" in h:
        print("already added")
        return 0

    n = 0
    for old, new, bucket in (
        (ANCHOR, PANEL + ANCHOR, "h"),
        (JS_STATE_OLD, JS_STATE_NEW, "j"),
        (JS_POLL_OLD, JS_POLL_NEW, "j"),
        (JS_CALL_OLD, JS_CALL_NEW, "j"),
        (JS_PILL_OLD, JS_PILL_NEW, "j"),
        (JS_BIND_OLD, JS_BIND_NEW, "j"),
    ):
        if bucket == "h" and old in h:
            h = h.replace(old, new, 1); n += 1
        elif bucket == "j" and old in j:
            j = j.replace(old, new, 1); n += 1

    if "function renderDownloads" not in j:
        j = j.replace("  function renderGpu() {",
                      JS_RENDER.strip("\n") + "\n\n  function renderGpu() {", 1)
        n += 1

    if ".dlrow" not in c:
        c = c.rstrip() + CSS_ADD
        n += 1

    io.open(HTML, "w", encoding="utf-8", newline="\n").write(h)
    io.open(JS, "w", encoding="utf-8", newline="\n").write(j)
    io.open(css_path, "w", encoding="utf-8", newline="\n").write(c)
    print(f"download panel wired ({n} edits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
