"""Add styles for the GPU panel (grid titles, proc rows)."""
from __future__ import annotations

import io
import sys

P = r"C:\ABRASAX\UI\abrasax-ui\web\console\console.css"

ADD = '''

/* ---------- gpu panel ---------- */
.gtitle {
  font: 600 10px ui-monospace, monospace;
  letter-spacing: .14em; text-transform: uppercase;
  color: #77779c; margin-bottom: 6px;
}
.procs { max-height: 148px; overflow: auto; margin-top: 4px; }
.proc {
  display: flex; gap: 8px; align-items: baseline;
  font: 10.5px ui-monospace, Consolas, monospace;
  padding: 2px 0; border-bottom: 1px solid #0f0f19;
  color: var(--dim);
}
.proc .pp { color: #63638a; min-width: 46px; }
.proc .pm { margin-left: auto; color: #7d7da8; }
'''


def main() -> int:
    src = io.open(P, encoding="utf-8").read()
    if ".gtitle" in src:
        print("already styled")
        return 0
    io.open(P, "w", encoding="utf-8", newline="\n").write(src.rstrip() + ADD)
    print("gpu styles added")
    return 0


if __name__ == "__main__":
    sys.exit(main())
