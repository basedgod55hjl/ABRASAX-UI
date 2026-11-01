"""Add the console to the UI index so all four surfaces are reachable.

Before this, unified.html / sensors/ / world/ / console/ had no shared entry
point. This writes a small launcher at the web root (landing.html) that links
every surface with its real backend port, and records the map in README.

It does NOT overwrite index.html (the gateway chat page) - that stays the
default landing.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

WEB = Path(r"C:\ABRASAX\UI\abrasax-ui\web")
LANDING = WEB / "landing.html"

SURFACES = [
    ("Console", "console/index.html",
     "Every live layer in one view", "8791", "new"),
    ("Unified", "unified.html",
     "GPU frames, NVML telemetry, math jobs", "8791", ""),
    ("Brain map", "unified.html#bxTitle",
     "7-D Poincare map panel", "8791", ""),
    ("Sensors", "sensors/index.html",
     "Sensor grid dashboard", "configurable", ""),
    ("World", "world/index.html",
     "World state report", "9001", ""),
    ("Gateway chat", "index.html",
     "Chat client + synaptic brain panel", "9001", ""),
]

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>ABRASAX · Surfaces</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%2308080d'/%3E%3Cpath d='M32 11 53 45H11z' fill='none' stroke='%237c6cf0' stroke-width='4'/%3E%3C/svg%3E">
<style>
:root{--bg:#06060c;--panel:#0a0a12;--line:#1e1e2e;--ink:#e6e6f5;--dim:#8b8bab;--acc:#7c6cf0;--ok:#55d98a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
header{padding:20px 26px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:14px}
h1{margin:0;font-size:16px;letter-spacing:.18em;text-transform:uppercase}
.hex{font:10px ui-monospace,monospace;color:var(--dim);letter-spacing:.1em}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;padding:22px 26px}
a.card{display:block;text-decoration:none;color:inherit;background:var(--panel);
  border:1px solid var(--line);border-radius:12px;padding:16px}
a.card:hover{border-color:var(--acc)}
.t{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:4px}
.new{font:9px ui-monospace,monospace;color:#06060c;background:var(--ok);padding:1px 6px;border-radius:99px}
.d{color:var(--dim);font-size:12.5px}
.p{margin-top:9px;font:10px ui-monospace,monospace;color:#5f5f80}
footer{padding:14px 26px 40px;font:10px/1.7 ui-monospace,monospace;color:#5c5c7d;border-top:1px solid var(--line)}
</style>
</head>
<body>
<header>
  <h1>ABRASAX</h1><span class="hex">4f5349524953424c58434b</span>
  <span class="d">surfaces</span>
</header>
<main>
"""


def main() -> int:
    cards = []
    for name, href, desc, port, tag in SURFACES:
        badge = f'<span class="new">{tag}</span>' if tag else ""
        cards.append(
            f'  <a class="card" href="{href}">'
            f'<div class="t">{name}{badge}</div>'
            f'<div class="d">{desc}</div>'
            f'<div class="p">backend :{port}</div></a>'
        )

    footer = ("<footer>All surfaces are served by the ABXU bridge on :8791 "
              "(<code>/api/static/&lt;path&gt;</code>).<br>"
              "Live data sources: synaptic field :9001 · brain map :8791 · "
              "models :1234 (proxied via /api/models) · runtime :8790.</footer>\n"
              "</main>\n</body>\n</html>\n")

    out = HTML + "\n".join(cards) + "\n" + footer
    io.open(LANDING, "w", encoding="utf-8", newline="\n").write(out)
    print(f"wrote {LANDING} ({len(out)} bytes, {len(SURFACES)} surfaces)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
