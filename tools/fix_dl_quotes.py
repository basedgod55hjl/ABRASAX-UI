"""Fix the quote escaping broken by the panel injection.

The generated line reads
    "</span><span class="pm">" + ...
whose inner double quotes terminate the string early. Rewrite it cleanly.
"""
from __future__ import annotations

import io
import sys

P = r"C:\ABRASAX\UI\abrasax-ui\web\console\console.js"

BAD = '            "</span><span class="pm">" + mib + " MiB " + rate + "</span></div>";'
GOOD = '            \'</span><span class="pm">\' + mib + " MiB " + rate + "</span></div>";'


def main() -> int:
    src = io.open(P, encoding="utf-8").read()
    if BAD not in src:
        print("pattern not found - inspecting")
        for ln in src.splitlines():
            if "MiB " in ln and "span" in ln:
                print("  ", ln.strip()[:120])
        return 0
    src = src.replace(BAD, GOOD, 1)
    io.open(P, "w", encoding="utf-8", newline="\n").write(src)
    print("fixed quote escaping")
    return 0


if __name__ == "__main__":
    sys.exit(main())
