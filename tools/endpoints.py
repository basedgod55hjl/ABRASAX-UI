"""Discover which API paths the legacy UI pages actually call.

sensors.js and world.js were written against a gateway on :9001 / a configurable
base. Before wiring anything together we need the exact path list so the live
bridge can satisfy them (or so we can prove it cannot).
"""
from __future__ import annotations

import re
from pathlib import Path

WEB = Path(r"C:\ABRASAX\UI\abrasax-ui\web")

TARGETS = {
    "sensors": WEB / "sensors" / "sensors.js",
    "world": WEB / "world" / "world.js",
    "brain_legacy": WEB / "brain.js",
    "unified": WEB / "unified.js",
    "brainmap": WEB / "brainmap.js",
}

PATH_RE = re.compile(r'["\'](/[a-zA-Z0-9_\-/.]{2,60})["\']')
PORT_RE = re.compile(r'127\.0\.0\.1:(\d{4})')


def main() -> int:
    for name, p in TARGETS.items():
        if not p.exists():
            print(f"{name}: MISSING {p}")
            continue
        src = p.read_text(encoding="utf-8", errors="replace")
        paths = sorted({m.group(1) for m in PATH_RE.finditer(src)
                        if not m.group(1).startswith(("//", "/v1/"))})
        ports = sorted(set(PORT_RE.findall(src)))
        print(f"\n=== {name} ({len(src)} bytes) ===")
        print(f"  ports: {ports or '-'}")
        for q in paths[:24]:
            print(f"    {q}")
        if len(paths) > 24:
            print(f"    ... +{len(paths) - 24} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
