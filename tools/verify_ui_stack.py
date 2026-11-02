"""Verify every UI surface serves and the console binds live data."""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

BRIDGE = "http://127.0.0.1:8791"
fails: list[str] = []


def ok(cond, label, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + f"{label:36s}" + str(detail))
    if not cond:
        fails.append(label)


def head(path, timeout=20):
    try:
        with urllib.request.urlopen(BRIDGE + path, timeout=timeout) as r:
            return r.status, len(r.read())
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception:
        return 0, 0


def main() -> int:
    print("[1] surfaces serve")
    for p in ("/api/static/landing.html",
              "/api/static/console/index.html",
              "/api/static/console/console.js",
              "/api/static/console/console.css",
              "/api/static/unified.html",
              "/api/static/index.html",
              "/api/static/sensors/index.html",
              "/api/static/world/index.html",
              "/api/static/brainmap.js"):
        code, n = head(p)
        ok(code == 200 and n > 300, p, f"{code} {n}b")

    print("[2] api endpoints")
    for p in ("/api/brain", "/api/stress", "/api/actions", "/api/unity", "/api/models"):
        try:
            with urllib.request.urlopen(BRIDGE + p, timeout=60) as r:
                d = json.loads(r.read())
            ok(d.get("ok") is not None or "rules" in d or "actions" in d
               or "data" in d, p, f"ok={d.get('ok')}")
        except Exception as e:  # noqa: BLE001
            ok(False, p, str(e)[:50])

    print("[3] models proxy")
    try:
        with urllib.request.urlopen(BRIDGE + "/api/models", timeout=30) as r:
            m = json.loads(r.read())
        ok(m.get("ok") is True and (m.get("count") or 0) > 0,
           "roster via proxy", f"count={m.get('count')}")
    except Exception as e:  # noqa: BLE001
        ok(False, "roster via proxy", str(e)[:50])

    print("[4] brain payload")
    with urllib.request.urlopen(BRIDGE + "/api/brain", timeout=90) as r:
        b = json.loads(r.read())
    ok((b.get("count") or 0) >= 80, "units", b.get("count"))
    ok(len({u["kind"] for u in (b.get("units") or [])}) >= 17, "classes")
    ok(bool((b.get("dna") or {}).get("bases")), "dna", (b.get("dna") or {}).get("bases"))
    ok(bool((b.get("learning") or {}).get("steps")), "learning")

    print("[5] console browser test")
    t0 = time.time()
    p = subprocess.run([sys.executable, r"C:\ABRASAX\UI\abrasax-ui\tools\verify_console.py"],
                       capture_output=True, text=True)
    tail = (p.stdout or "").strip().splitlines()[-1:] or [""]
    ok(p.returncode == 0, "verify_console.py", f"{tail[0]} ({time.time()-t0:.0f}s)")

    print("RESULT:", "PASS" if not fails else f"FAIL {fails}")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
