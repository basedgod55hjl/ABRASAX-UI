"""Document the UI stack: what exists, what each surface talks to, how to verify."""
from __future__ import annotations

import io
import sys
from pathlib import Path

DOC = Path(r"C:\ABRASAX\UI\abrasax-ui\UI-STACK.md")

BODY = """# ABRASAX UI stack

All surfaces are served by the ABXU bridge on **:8791** at
`/api/static/<path>`, from `UI/abrasax-ui/web/`.

## Entry points

| Surface | Path | Backend |
|---|---|---|
| **Surfaces launcher** | `landing.html` | links all of the below |
| **Console** (new) | `console/index.html` | `:8791`, `:9001`, `:1234` via proxy |
| Unified | `unified.html` | `:8791` (`/api/*`) |
| Brain map panel | `unified.html#bxTitle` | `:8791` (`/api/brain`) |
| Sensors | `sensors/index.html` | configurable base url |
| World | `world/index.html` | `:9001` |
| Gateway chat | `index.html` | `:9001` |

## The Console

`console/` binds every live layer into one view, replacing three pages that each
talked to a different port with no shared entry point.

Panels and their real sources:

| Panel | Source | What it shows |
|---|---|---|
| synaptic field | `:9001/brain/state` | 4096 nodes, 111k synapses, CUDA backend, primal seal |
| flywire reference | same | 139,255 neurons / 79 neuropils (FlyWire v783) |
| 7-D brain map | `:8791/api/brain` | 87 units / 17 classes, tension, radial spread |
| frequency DNA | same | 7-base strand, generation, seed, lineage mutation |
| top movers | same | per-unit norm + measured burst velocity |
| constraints | `:8791/api/stress` | rule breaches with limits and reasons |
| actuate | `:8791/api/actions` + `POST /api/action` | gated mutations, audited |
| models | `:8791/api/models` | LM Studio roster (23 models) |
| services | all of the above | live up/down with freshness |

### Design rules it follows

1. **Every panel carries its own freshness pill** (`now` / `12s` / `down`). A
   dead source never renders as if it were live.
2. **All fetches are abortable** with a timeout, so one dead service cannot
   freeze the console.
3. **No fabricated values.** If `/api/models` fails, the panel shows the actual
   error and hint rather than an empty list pretending success.
4. **No credentials in the browser.** LM Studio requires a Bearer token, so the
   bridge proxies the roster at `/api/models`; the page holds nothing secret.

### Why `/api/models` exists

LM Studio enforces `Authorization: Bearer <token>`. A browser page must not hold
that token, so a direct `fetch` from the console failed (models showed "down",
0 rows). The bridge already has the token from `LM_API_TOKEN` /
`LM_GUARD_UPSTREAM_KEY`, so it proxies `/v1/models` and the console needs no auth.
Verified: `ok=True count=23`.

## Verification

```bash
# assets serve
curl -s -oN /dev/null -w "%{http_code}\\n" http://127.0.0.1:8791/api/static/console/index.html

# browser-level: binds live data from every source, 0 console errors
python UI/abrasax-ui/tools/verify_console.py

# pixel-level: real render, not a blank shell
python UI/abrasax-ui/tools/verify_console_pixels.py
```

`verify_console.py` result (headless Chrome):

```
synaptic nodes 4,096 · synapses 111,027 · flywire 139,255
brain units 87 · classes 17 · dna AAACGGA
unit rows 14 · rules 4 · actions 4 · services 4 · models 23
freshness pills: now, 1s, 1s, 1s, 1s
RESULT: PASS
```

`verify_console_pixels.py`: 1684x1205, 3 704 distinct colours, 51.4 %
non-background — a genuinely populated page, not an empty shell.

## Tools

| script | purpose |
|---|---|
| `tools/endpoints.py` | lists which API paths each legacy page calls |
| `tools/verify_console.py` | headless-Chrome binding + error check |
| `tools/verify_console_pixels.py` | confirms the render is real |
| `tools/write_landing.py` | regenerates `landing.html` |
| `tools/add_models_proxy.py` | adds `/api/models` to the bridge |

## Known limits

- `sensors/` expects a **configurable** base URL and was written for a different
  grid API; it is served but not wired to the brain bridge.
- `index.html` (gateway chat) still targets `:9001` and works against the live
  `abrasax gateway` process.
- The console polls in the browser at 5 s; `/api/brain` itself samples on the
  bridge side (~5–16 s cold), so panel values can lag a tick behind real time.
  The freshness pills make that visible rather than hiding it.
"""


def main() -> int:
    if DOC.exists() and "The Console" in DOC.read_text(encoding="utf-8"):
        print("already documented")
        return 0
    io.open(DOC, "w", encoding="utf-8", newline="\n").write(BODY)
    print(f"wrote {DOC} ({len(BODY)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
