"""Replace the accidental Python docstring header in console.js with a JS comment."""
from __future__ import annotations

import io
import sys

P = r"C:\ABRASAX\UI\abrasax-ui\web\console\console.js"

JS_HEADER = '''/* ABRASAX Console - unified data layer.
 *
 * Binds every live surface into ONE coherent view instead of three
 * disconnected pages with different ports:
 *
 *   :9001  /brain/state   synaptic field (4096 nodes, FlyWire connectome)
 *   :8791  /api/brain     7-D Poincare map (87 units / 17 classes)
 *   :8791  /api/stress    constraint rules + breaches
 *   :8791  /api/actions   safelisted actuation + audit
 *   :1234  /v1/models     LM Studio model roster
 *   :8790  runtime        ABXU compute runtime
 *
 * Rules: every panel reports its own freshness and failure, all fetches are
 * abortable so one dead service cannot freeze the console, and nothing shows a
 * fabricated value - a down source says "down".
 */
'''


def main() -> int:
    src = io.open(P, encoding="utf-8").read()
    if src.startswith("/* ABRASAX Console - unified data layer."):
        print("already fixed")
        return 0
    if not src.startswith('"""'):
        print("FAIL: expected leading docstring")
        return 1
    end = src.find('"""', 3)
    if end == -1:
        print("FAIL: unterminated docstring")
        return 1
    body = src[end + 3:].lstrip("\n")
    io.open(P, "w", encoding="utf-8", newline="\n").write(JS_HEADER + "\n" + body)
    print("header replaced")
    return 0


if __name__ == "__main__":
    sys.exit(main())
