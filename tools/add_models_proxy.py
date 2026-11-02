"""Proxy the LM Studio model roster through the bridge so auth is handled server-side.

The console fetched http://127.0.0.1:1234/v1/models directly from the browser,
which fails because LM Studio requires `Authorization: Bearer <token>` and a
browser will not (and should not) hold that credential.

Fix: add GET /api/models to the bridge. The bridge already knows the token
(LM_API_TOKEN / LM_GUARD_UPSTREAM_KEY env, same one the guard uses), so it can
proxy the roster. The console then needs no credentials at all.
"""
from __future__ import annotations

import ast
import io
import sys

PATH = r"C:\ABRASAX\CORE\unified\http_bridge.py"
MARKER = "_ABX_MODELS_PROXY"

HELPER = '''
    def _models_proxy(self) -> None:
        """Proxy LM Studio's model roster with the server-side token. (%s)

        The browser must never hold the API token, so this cannot be a direct
        fetch from the page.
        """
        import urllib.error
        import urllib.request as _ur
        tok = (os.environ.get("LM_API_TOKEN")
               or os.environ.get("LM_GUARD_UPSTREAM_KEY")
               or "").strip()
        hdrs = {"Accept": "application/json"}
        if tok:
            hdrs["Authorization"] = "Bearer " + tok
        url = "http://127.0.0.1:1234/v1/models"
        try:
            req = _ur.Request(url, headers=hdrs)
            with _ur.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            self._json(200, {"ok": True, "source": "lmstudio",
                             "count": len(data.get("data") or []),
                             "data": data.get("data") or []})
        except urllib.error.HTTPError as e:
            self._json(200, {"ok": False, "error": f"HTTP {e.code}",
                             "hint": "LM Studio token invalid or missing",
                             "data": []})
        except Exception as exc:  # noqa: BLE001
            self._json(200, {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                             "data": []})
''' % MARKER

OLD_ROUTE = '''            elif path == "/api/unity":
                self._json(200, self._unity_status())
'''
NEW_ROUTE = '''            elif path == "/api/unity":
                self._json(200, self._unity_status())
            elif path == "/api/models":
                self._models_proxy()
'''


def main() -> int:
    src = io.open(PATH, encoding="utf-8").read()
    if MARKER in src:
        print("already added")
        return 0
    if OLD_ROUTE not in src:
        print("FAIL: unity route anchor missing")
        return 1

    src = src.replace(OLD_ROUTE, NEW_ROUTE, 1)

    anchor = "    def _unity_status(self) -> dict[str, Any]:"
    if anchor not in src:
        print("FAIL: _unity_status anchor missing")
        return 1
    src = src.replace(anchor, HELPER.strip("\n") + "\n\n" + anchor, 1)

    ast.parse(src)
    io.open(PATH, "w", encoding="utf-8", newline="\n").write(src)
    print("added /api/models proxy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
