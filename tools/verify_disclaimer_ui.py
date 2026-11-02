"""Verify the disclaimer is reachable from the console UI in a real browser."""
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
    profile = tempfile.mkdtemp(prefix="abx-disc-")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-first-run",
        f"--remote-debugging-port={PORT + 13}", f"--user-data-dir={profile}",
        "--window-size=1700,1500", "--hide-scrollbars", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = True
    try:
        ws_url = None
        for _ in range(45):
            try:
                raw = urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT + 13}/json/list", timeout=2).read()
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
            dl = time.time() + 45
            while time.time() < dl:
                msg = ws.recv()
                if msg.get("method") == "Runtime.exceptionThrown":
                    d = msg["params"]["exceptionDetails"]
                    errs.append(str(d.get("exception", {}).get("description", d))[:200])
                if msg.get("method") == "Runtime.consoleAPICalled":
                    p = msg["params"]
                    if p.get("type") == "error":
                        errs.append(str(p.get("args"))[:200])
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
        time.sleep(18)

        v = js("""
        (() => {
          const a = document.querySelector(".discbar a");
          return {
            hasBar: !!document.querySelector(".discbar"),
            href: a ? a.getAttribute("href") : null,
            label: a ? a.textContent.trim() : null,
            text: document.querySelector(".discbar") ?
                  document.querySelector(".discbar").textContent.trim() : null,
          };
        })()
        """)
        print(json.dumps(v, indent=2))

        def chk(c, label, d=""):
            nonlocal ok
            print(("  PASS  " if c else "  FAIL  ") + f"{label:34s}{d}")
            if not c:
                ok = False

        chk(v.get("hasBar"), "disclaimer bar rendered")
        chk(v.get("href") == "/api/disclaimer", "links to /api/disclaimer", v.get("href"))
        chk("Disclaimer" in str(v.get("label")), "label text", v.get("label"))
        chk("audited" in str(v.get("text")), "posture note shown",
            str(v.get("text"))[-40:])

        # the link target must actually serve markdown
        status = js("""
        (async () => {
          const r = await fetch("/api/disclaimer");
          const t = await r.text();
          return r.status + " " + r.headers.get("content-type") + " " + t.length;
        })()
        """)
        print("target:", status)
        chk(str(status).startswith("200"), "target returns 200", str(status)[:40])
        chk("markdown" in str(status), "served as markdown")

        if errs:
            print("CONSOLE ERRORS:")
            for e in errs[:5]:
                print("  ", e[:180])
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
