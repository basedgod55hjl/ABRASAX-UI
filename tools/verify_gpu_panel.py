"""Verify the dual-GPU panel binds live data in a browser."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, r"C:\ABRASAX\CORE\unified")
from verify_brain_ui import PORT, WS  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "http://127.0.0.1:8791/api/static/console/index.html"


def main() -> int:
    profile = tempfile.mkdtemp(prefix="abx-gpu-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-first-run",
        f"--remote-debugging-port={PORT + 9}", f"--user-data-dir={profile}",
        "--window-size=1700,1400", "--hide-scrollbars", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = True
    try:
        ws_url = None
        for _ in range(45):
            try:
                raw = urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT + 9}/json/list", timeout=2).read()
                for t in json.loads(raw):
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        ws_url = t["webSocketDebuggerUrl"]; break
                if ws_url:
                    break
            except Exception:
                pass
            time.sleep(0.4)
        if not ws_url:
            print("FAIL: no target")
            return 1

        ws = WS(ws_url)
        mid = [0]
        errs: list[str] = []

        def call(method, params=None, wait=True):
            mid[0] += 1
            my = mid[0]
            ws.send({"id": my, "method": method, "params": params or {}})
            if not wait:
                return None
            dl = time.time() + 50
            while time.time() < dl:
                msg = ws.recv()
                if msg.get("method") == "Runtime.exceptionThrown":
                    d = msg["params"]["exceptionDetails"]
                    errs.append(str(d.get("exception", {}).get("description", d))[:250])
                if msg.get("method") == "Runtime.consoleAPICalled":
                    p = msg["params"]
                    if p.get("type") == "error":
                        errs.append(str(p.get("args"))[:250])
                if msg.get("id") == my:
                    return msg.get("result")
            return None

        def js(expr):
            r = call("Runtime.evaluate",
                     {"expression": expr, "returnByValue": True, "awaitPromise": True})
            return (r or {}).get("result", {}).get("value")

        call("Runtime.enable", wait=False)
        call("Page.enable", wait=False)
        call("Page.navigate", {"url": URL})
        time.sleep(24)

        v = js("""
        (() => {
          const t = (id) => { const e = document.getElementById(id);
                              return e ? e.textContent.trim() : null; };
          return {
            nvName: t("nv-name"), nvUtil: t("nv-util"), nvTemp: t("nv-temp"),
            nvVram: t("nv-vram"), nvPcie: t("nv-pcie"), nvSm: t("nv-sm"),
            amdName: t("amd-name"), amdMode: t("amd-mode"),
            amdDrv: t("amd-drv"), amdCtr: t("amd-ctr"),
            procs: document.querySelectorAll("#gpu-procs .proc").length,
            gpuPill: t("fresh-gpu"),
            units: t("bx-units"), classes: t("bx-classes"),
          };
        })()
        """)
        print(json.dumps(v, indent=2))

        def chk(c, label, d=""):
            nonlocal ok
            print(("  PASS  " if c else "  FAIL  ") + label + ("  " + str(d) if d else ""))
            if not c:
                ok = False

        chk("GTX" in str(v.get("nvName")), "NVIDIA name bound", v.get("nvName"))
        chk(v.get("nvUtil") not in (None, "—"), "NVIDIA util", v.get("nvUtil"))
        chk(v.get("nvTemp") not in (None, "—"), "NVIDIA temp", v.get("nvTemp"))
        chk("GiB" in str(v.get("nvVram")), "NVIDIA vram", v.get("nvVram"))
        chk("gen" in str(v.get("nvPcie")), "NVIDIA pcie", v.get("nvPcie"))
        chk("Radeon" in str(v.get("amdName")), "AMD name bound", v.get("amdName"))
        chk(v.get("amdMode") not in (None, "—"), "AMD mode", v.get("amdMode"))
        chk(v.get("procs", 0) > 0, "gpu compute processes", v.get("procs"))
        chk(v.get("gpuPill") not in (None, "—", "down"), "gpu freshness", v.get("gpuPill"))
        chk(v.get("units") not in (None, "—"), "brain units still bound", v.get("units"))
        chk(v.get("classes") not in (None, "—"), "brain classes", v.get("classes"))

        if errs:
            print("CONSOLE ERRORS:")
            for e in errs[:6]:
                print("  ", e[:200])
            ok = False

        print("RESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
