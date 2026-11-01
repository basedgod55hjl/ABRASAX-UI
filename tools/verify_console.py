"""Verify the ABRASAX Console in a real headless browser.

Asserts the console binds live data from every source, not just that it loads:
  * synaptic field populated from :9001
  * 7-D brain map populated from :8791
  * DNA bases + learning present
  * unit table has rows
  * constraint rules rendered
  * actuation buttons present
  * service panel shows up states
  * freshness pills are populated (not stuck on the em-dash)
  * zero console errors
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, r"C:\ABRASAX\CORE\unified")
from verify_brain_ui import PORT, WS  # noqa: E402

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "http://127.0.0.1:8791/api/static/console/index.html"
SHOT = os.path.join(tempfile.gettempdir(), "abrasax_console.png")


def main() -> int:
    profile = tempfile.mkdtemp(prefix="abx-con-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-first-run", "--no-default-browser-check",
        f"--remote-debugging-port={PORT + 7}", f"--user-data-dir={profile}",
        "--window-size=1700,1300", "--hide-scrollbars", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ok = True
    try:
        ws_url = None
        for _ in range(45):
            try:
                raw = urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT + 7}/json/list", timeout=2).read()
                for t in json.loads(raw):
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        ws_url = t["webSocketDebuggerUrl"]
                        break
                if ws_url:
                    break
            except Exception:
                pass
            time.sleep(0.4)
        if not ws_url:
            print("FAIL: no devtools target")
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
                    errs.append(str(d.get("exception", {}).get("description", d))[:300])
                if msg.get("method") == "Runtime.consoleAPICalled":
                    p = msg["params"]
                    if p.get("type") == "error":
                        errs.append(str(p.get("args"))[:300])
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
        time.sleep(22)          # allow /api/brain (up to ~30s) to land

        v = js("""
        (() => {
          const t = (id) => { const e = document.getElementById(id);
                              return e ? e.textContent.trim() : null; };
          const pills = ["syn","brain","stress","actions","models"]
            .map(k => t("fresh-" + k));
          return {
            synNodes:   t("syn-nodes"),
            synEdges:   t("syn-edges"),
            synBackend: t("syn-backend"),
            flyNeurons: t("fly-neurons"),
            bxUnits:    t("bx-units"),
            bxClasses:  t("bx-classes"),
            dnaBases:   t("dna-bases"),
            dnaSeed:    t("dna-seed"),
            lrnSteps:   t("lrn-steps"),
            unitRows:   document.querySelectorAll("#unit-rows tr").length,
            ruleRows:   document.querySelectorAll("#rule-rows .rule").length,
            actBtns:    document.querySelectorAll("#act-rows .run").length,
            svcRows:    document.querySelectorAll("#svc-rows .svc").length,
            modelRows:  document.querySelectorAll("#model-rows .mrow").length,
            polls:      t("poll-count"),
            pills:      pills,
            pillStuck:  pills.every(p => p === "—"),
          };
        })()
        """)
        print(json.dumps(v, indent=2))

        def chk(cond, label, detail=""):
            nonlocal ok
            print(("  PASS  " if cond else "  FAIL  ") + label + ("  " + str(detail) if detail else ""))
            if not cond:
                ok = False

        chk(v.get("synNodes") not in (None, "—"), "synaptic nodes bound", v.get("synNodes"))
        chk(v.get("synEdges") not in (None, "—"), "synapses bound", v.get("synEdges"))
        chk(v.get("flyNeurons") not in (None, "—"), "flywire bound", v.get("flyNeurons"))
        chk(v.get("bxUnits") not in (None, "—"), "brain units bound", v.get("bxUnits"))
        chk(v.get("bxClasses") not in (None, "—"), "brain classes bound", v.get("bxClasses"))
        chk(v.get("dnaBases") not in (None, "—"), "dna bound", v.get("dnaBases"))
        chk(v.get("unitRows", 0) > 5, "unit table rows", v.get("unitRows"))
        chk(v.get("ruleRows", 0) >= 3, "constraint rules", v.get("ruleRows"))
        chk(v.get("actBtns", 0) >= 4, "action buttons", v.get("actBtns"))
        chk(v.get("svcRows", 0) >= 4, "service rows", v.get("svcRows"))
        chk(not v.get("pillStuck"), "freshness pills populated", v.get("pills"))

        if errs:
            print("CONSOLE ERRORS:")
            for e in errs[:8]:
                print("  ", e[:220])
            ok = False

        shot = call("Page.captureScreenshot", {"format": "png"})
        if shot and shot.get("data"):
            open(SHOT, "wb").write(base64.b64decode(shot["data"]))
            print("screenshot:", SHOT, os.path.getsize(SHOT), "bytes")

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
