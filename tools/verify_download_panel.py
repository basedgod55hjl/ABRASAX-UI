"""Verify the aria2 download panel renders and works in a real browser."""
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
DL = "https://raw.githubusercontent.com/aria2/aria2/master/README.rst"


def main() -> int:
    profile = tempfile.mkdtemp(prefix="abx-dl-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-first-run",
        f"--remote-debugging-port={PORT + 11}", f"--user-data-dir={profile}",
        "--window-size=1700,1500", "--hide-scrollbars", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = True
    try:
        ws_url = None
        for _ in range(45):
            try:
                raw = urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT + 11}/json/list", timeout=2).read()
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
        time.sleep(22)

        v = js("""
        (() => {
          const t = (id) => { const e = document.getElementById(id);
                              return e ? e.textContent.trim() : null; };
          return { hasInput: !!document.getElementById("dl-url"),
                   hasGo: !!document.getElementById("dl-go"),
                   ver: t("dl-ver"), pill: t("fresh-dl"),
                   rows: document.querySelectorAll("#dl-rows .proc").length };
        })()
        """)
        print("panel:", json.dumps(v))

        def chk(c, label, d=""):
            nonlocal ok
            print(("  PASS  " if c else "  FAIL  ") + f"{label:32s}{d}")
            if not c:
                ok = False

        chk(v.get("hasInput"), "url input present")
        chk(v.get("hasGo"), "fetch button present")
        chk("aria2" in str(v.get("ver")), "version shown", v.get("ver"))
        chk(v.get("pill") not in (None, "—", "down"), "freshness", v.get("pill"))

        # drive a real download through the UI
        res = js("""
        (async () => {
          document.getElementById("dl-url").value = "%s";
          document.getElementById("dl-cap").value = "2";
          document.getElementById("dl-go").click();
          for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 600));
            const out = document.getElementById("dl-out").textContent;
            const rows = document.querySelectorAll("#dl-rows .proc").length;
            if (out && out.indexOf("started") === 0 && rows > 0) {
              await new Promise(r => setTimeout(r, 3000));
              return document.getElementById("dl-rows").textContent;
            }
          }
          return "TIMEOUT out=" + document.getElementById("dl-out").textContent;
        })()
        """ % DL)
        print("ui download ->", str(res)[:160])
        chk("done" in str(res).lower(), "download completed via UI")

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
