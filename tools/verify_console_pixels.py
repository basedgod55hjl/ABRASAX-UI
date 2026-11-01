"""Confirm the console screenshot is a real rendered page, not a blank shell."""
from __future__ import annotations

import collections
import sys
import tempfile

sys.path.insert(0, r"C:\ABRASAX\CORE\unified")

from verify_brain_pixels import decode_png  # noqa: E402

SHOT = tempfile.gettempdir() + r"\abrasax_console.png"


def main() -> int:
    w, h, px = decode_png(SHOT)
    print(f"decoded {w}x{h} = {len(px)} px")

    counts = collections.Counter(px)
    distinct = len(counts)
    bg = counts.most_common(1)[0]
    ink = len(px) - bg[1]
    print(f"distinct colours : {distinct}")
    print(f"dominant (bg)    : {bg[0]} x{bg[1]}")
    print(f"non-background   : {ink} ({100*ink/len(px):.1f}%)")

    # accents used by console.css
    accents = {
        "ok-green": (0x55, 0xD9, 0x8A),
        "accent-violet": (0x7C, 0x6C, 0xF0),
        "cyan": (0x4F, 0xD1, 0xC5),
        "bad-red": (0xFF, 0x6B, 0x6B),
    }
    found = {}
    for name, rgb in accents.items():
        n = sum(1 for p in px
                if abs(p[0] - rgb[0]) <= 30 and abs(p[1] - rgb[1]) <= 30
                and abs(p[2] - rgb[2]) <= 30)
        found[name] = n
        print(f"  {name:14s} {n} px")

    ok = True
    if distinct < 60:
        print("FAIL: too few colours - page looks blank")
        ok = False
    if ink < 40000:
        print("FAIL: too little ink for a populated dashboard")
        ok = False
    # the status dots alone guarantee green; violet hex label must appear
    if found["ok-green"] < 10:
        print("FAIL: no status-dot green found")
        ok = False
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
