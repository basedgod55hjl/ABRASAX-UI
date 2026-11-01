# ABRASAX gateway chat (static UI)

Single-page chat client for the ABRASAX gateway on `127.0.0.1:9001`. Plain HTML/CSS/JS —
no build step, no framework, no CDN, no network access needed beyond the gateway itself.

Design register: **Operate** for the chat shell, **Monitor** for the brain panel
(`DOC/DESIGN-SYSTEM.md` §1). One accent (`--accent`) marks live/interactive state only;
every number is mono + `tabular-nums`.

## Serve it

```bat
cd C:\ABRASAX\UI\abrasax-ui\web
C:\ABRASAX\PYTHON\.venv_gui\Scripts\python.exe -m http.server 8090 --bind 127.0.0.1
```

Open <http://127.0.0.1:8090/>.

`python -m http.server` from any Python 3 works too; the venv path is the house interpreter.
The gateway must already be running (`abrasax gateway`, port 9001) for chat and models. If it is
down the page still loads, shows **gateway offline — retrying every 10 s** in a banner, and keeps
the composer enabled so the retry window is usable.

## What it does

| Element | Source |
|---|---|
| Model dropdown | `GET /v1/models`, scoped to the pinned route (disabled under `auto`: the router then uses provider defaults) |
| Route selector | `auto` / `lmstudio` / `nvidia` / `xpl`, sent as `abrasax.route` + a `provider:model` prefix |
| Chat | `POST /v1/chat/completions`, OpenAI body shape, `stream:false` |
| Telemetry strip | `GET /health` every 10 s — status, version, service, client-measured latency |
| Errors | red bubble with an `HTTP <status>` chip + the gateway's own message; never swallowed |
| Composer | focused on load; `Send` yields to `Stop` while a request is in flight (button or `Esc`) |
| Brain panel | `GET /brain/state`, `/brain/texture`, `/brain/fly`, `/metrics`; `POST /brain/step` |

Request body for route `lmstudio` (auto sends no `model`, only `abrasax.route`):

```json
{
  "model": "lmstudio:liquid/lfm2.5-1.2b",
  "messages": [{"role": "user", "content": "hi"}],
  "max_tokens": 512,
  "temperature": 0.7,
  "stream": false,
  "abrasax": {"route": "lmstudio"}
}
```

## Brain panel

Monitor surface: dense rows, hairlines instead of card chrome, one soft shadow for the
floating panel.

- **64×64 heatmap** — `/brain/texture`, base64 uint8 row-major, drawn pixelated at 256×256.
- **mean_state sparkline** — last **60** samples held in memory (10 s cadence, so ~10 min),
  with a `min / max` readout. Nothing is persisted; a reload starts a fresh buffer.
- **fly reference row** — `139,255 neurons / 54.5M synapses / recip 0.266` from
  `state.fly` (FlyWire v783, CC-BY-4.0), falling back to the static values in the markup
  when `/brain/state` omits the block.
- **vram / disk / uptime** — parsed from the Prometheus text at `:9001/metrics`
  (`abrasax_gateway_uptime_seconds` is present today; vram/disk have **no** gauge yet, so
  those cells read `—` with a tooltip naming the missing gauge instead of inventing a number).
- Only `/brain/state`, `/brain/texture`, `/brain/fly` and `/metrics` are read.
  `LOGS/ops-state.json` is a local file with no HTTP route — the panel never tries it.

## Gateway quirks this UI works around

1. **No CORS preflight.** Gateway 0.4.0 has no `OPTIONS` handler (`501`), so a cross-origin
   `Content-Type: application/json` POST from `:8090` fails preflight. The page therefore posts
   with `Content-Type: text/plain;charset=UTF-8` (CORS-safelisted → no preflight); the gateway
   parses the raw body as JSON regardless. Change `POST_CONTENT_TYPE` in `app.js` if you ever
   serve this page same-origin with the gateway.
2. **`stream:true` is rejected** with `400 stream=true is not supported yet; use false`, so replies
   are non-streaming (no fake typing stream — just a thinking bubble until the JSON arrives).
3. **`/v1/models` can contain non-string ids** (e.g. `"id": true` from the `xpl` alias map). The
   dropdown drops those and reports how many were skipped in the status line.
4. **A bare model id is ignored** — `abrasax/gateway.py:79-85` only honours `lmstudio:` /
   `nvidia:` / `xpl:` prefixes. Picking a model therefore sends `"<route>:<id>"`; under `auto` the
   dropdown is disabled because the gateway would discard the id and use each provider's default.

## Design tokens

Declared once in `styles.css :root` and consumed by both stylesheets:

```
--bg #08080d   --surface #101018   --surface-2 #15151f   --border #23233a
--text #d7d7e4 --muted #7d7d94     --accent #7c6cf0
--ok #2ee6a0   --warn #ffb020      --err #ff5f6d
--radius 14px (panel) · --radius-control 6px (controls)
--space-1..4 4/6/8/14
```

Derived shades (`--bg-well`, `--surface-raised`, `--accent-hover`, `--err-line`, …) also live in
`:root`; no colour literal appears in a rule body. Legacy `--panel / --panel-2 / --line` are
aliases of the canonical names so older markup keeps resolving.

## Accessibility

- `:focus-visible` ring (2 px `--accent`, 2 px offset) on every control; `outline:none` is never
  applied without a replacement.
- `aria-live` on the telemetry strip and the status line; the offline banner is `assertive`.
- 44 px minimum hit targets below 620 px (buttons, selects, textarea).
- `prefers-reduced-motion` disables message/typing animation and all transitions.
- `Esc` stops the in-flight completion; focus returns to the composer when it settles.

## Config

- Gateway URL override: `?gateway=http://127.0.0.1:9002` for that page load only, or edit
  `DEFAULT_GATEWAY` in `app.js`.
- Model/route choices persist in `localStorage`.
- `window.AbrasaXUI.send("…")` / `.stop()` / `.pollHealth()` / `.busy()` / `.history()` are
  exposed for smoke tests; `window.AbrasaBrain.samples()` / `.refresh()` do the same for the panel.

## Files

```
index.html   markup + telemetry strip + brain panel
styles.css   tokens, Operate shell, responsive + reduced-motion
app.js       models, health poll, chat, stop, error handling
brain.css    Monitor panel: heatmap, sparkline, fly row, metrics line
brain.js     /brain/* + /metrics polling, sparkline buffer, texture draw
README.md    this file
```

`../web/chat/` is the older Flask-proxied chat page (Bootstrap CDN, targets `:9000`); it is left
untouched and is not required by this UI.
