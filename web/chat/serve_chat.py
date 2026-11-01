#!/usr/bin/env python3
"""
ABRASAX Web Chat Server v1.0
=============================
Flask-based server that:
  - Serves the static web chat UI (index.html)
  - Proxies /api/* requests to the ABRASAX gateway at http://127.0.0.1:9000
  - Provides a simple REST API for the chat interface

HEX: 4f5349524953424c58434b
"""

import json
import logging
import os
import sys
from pathlib import Path

import httpx
from flask import Flask, jsonify, request, send_from_directory

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HOST = os.environ.get("WEB_CHAT_HOST", "127.0.0.1")
PORT = int(os.environ.get("WEB_CHAT_PORT", "5000"))
GATEWAY_URL = os.environ.get("ABRASAX_GATEWAY_URL", "http://127.0.0.1:9000")
STATIC_DIR = Path(__file__).resolve().parent
PRIMAL_HEX = "4f5349524953424c58434b"
PHI = 1.618033988749895

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ABRASAX_WEB_CHAT")

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")

# Synchronous httpx client
_client = httpx.Client(timeout=30.0, verify=False)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """Serve the main chat UI."""
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/health", methods=["GET"])
def proxy_health():
    """Proxy health check to the ABRASAX gateway."""
    try:
        resp = _client.get(f"{GATEWAY_URL}/health")
        if resp.status_code == 200:
            data = resp.json()
            data["gateway"] = GATEWAY_URL
            data["web_chat_server"] = f"http://{HOST}:{PORT}"
            data["hex"] = PRIMAL_HEX
            data["phi"] = PHI
            return jsonify(data)
        else:
            return jsonify({
                "status": "error",
                "code": resp.status_code,
                "gateway": GATEWAY_URL,
            }), resp.status_code
    except Exception as e:
        logger.warning(f"Health check failed: {e}")
        return jsonify({
            "status": "unreachable",
            "gateway": GATEWAY_URL,
            "error": str(e),
        }), 503


@app.route("/api/chat", methods=["POST"])
def proxy_chat():
    """Proxy chat messages to the ABRASAX gateway."""
    data = request.get_json(silent=True) or {}
    message = data.get("message", "")
    source = data.get("source", "web_chat")
    history = data.get("history", [])

    if not message:
        return jsonify({"error": "message is required"}), 400

    logger.info(f"Chat from web: {message[:80]}...")

    # Try the primary OpenAI-compatible endpoint first
    try:
        messages = [
            {"role": "system",
             "content": "You are ABRASAX, a 7th Dimensional AI Operating System. HEX: 4f5349524953424c58434b"}
        ]

        # Add conversation history for context
        for msg in history[-10:]:
            role = "user" if msg.get("role") == "user" else "assistant"
            messages.append({"role": role, "content": msg.get("content", "")})

        # Ensure the current message is included
        if not history or history[-1].get("content") != message:
            messages.append({"role": "user", "content": message})

        resp = _client.post(
            f"{GATEWAY_URL}/v1/chat/completions",
            json={
                "messages": messages,
                "max_tokens": 2048,
                "temperature": 0.7,
            },
            timeout=60.0,
        )

        if resp.status_code == 200:
            resp_data = resp.json()
            choices = resp_data.get("choices", [])
            if choices:
                content = choices[0].get("message", {}).get("content", "")
                # Try delta for streaming response format
                if not content:
                    content = choices[0].get("delta", {}).get("content", "")
                # Handle non-standard formats
                if not content:
                    msg_obj = choices[0].get("message", {})
                    if isinstance(msg_obj, dict):
                        content = msg_obj.get("content", "")
                    elif isinstance(msg_obj, str):
                        content = msg_obj
                if content:
                    return jsonify({"content": content, "source": source})
            return jsonify({"content": json.dumps(resp_data, indent=2), "source": source})

        logger.info(f"v1 endpoint returned {resp.status_code}, trying /chat fallback...")

    except Exception as e:
        logger.warning(f"v1/chat/completions failed: {e}")

    # Fallback: POST to /chat with simple payload
    try:
        payload = {
            "message": message,
            "source": source,
        }
        resp = _client.post(
            f"{GATEWAY_URL}/chat",
            json=payload,
            timeout=60.0,
        )

        if resp.status_code == 200:
            try:
                resp_data = resp.json()
                content = (
                    resp_data.get("content")
                    or resp_data.get("response")
                    or resp_data.get("message")
                    or resp_data.get("text")
                    or json.dumps(resp_data)
                )
            except (json.JSONDecodeError, Exception):
                content = resp.text

            return jsonify({"content": content, "source": source})

        return jsonify({
            "error": f"Gateway returned HTTP {resp.status_code}",
            "content": f"Gateway error: HTTP {resp.status_code}",
        }), 502

    except Exception as e:
        logger.error(f"Chat proxy failed: {e}")
        return jsonify({
            "error": str(e),
            "content": f"Gateway unreachable: {e}",
        }), 502



# ---------------------------------------------------------------------------
# FL Studio payload -- live analysis via abrasax.flstudio
# ---------------------------------------------------------------------------

PAYLOAD_PATH = os.environ.get(
    "ABRASAX_PAYLOAD", r"J:\Sandisk_Backup\FL_Studio_Payload_Extracted\Payload~"
)


def _payload_report():
    """Analyse the FL Studio payload and return a JSON-safe dict.

    Every value is computed, not hardcoded -- absent module or payload yields a
    structured error rather than an exception.
    """
    try:
        from abrasax import flstudio as fs
    except Exception as e:                       # noqa: BLE001
        return {"ok": False, "error": f"abrasax.flstudio unavailable: {e}"}

    p = Path(PAYLOAD_PATH)
    if not p.is_file():
        return {"ok": False, "error": f"payload not found: {p}"}

    try:
        members = fs.read_cpio_members(PAYLOAD_PATH, limit=fs.PAYLOAD_ARCHIVE_SIZE)
        report = {
            "ok": True,
            "path": str(p),
            "file_size": p.stat().st_size,
            "archive_size": fs.PAYLOAD_ARCHIVE_SIZE,
            "archive_exact": fs.cpio_is_exact(PAYLOAD_PATH, fs.PAYLOAD_ARCHIVE_SIZE),
            "members": len(members),
            "payload_bytes": sum(m.size for m in members),
            "tail_nonzero": fs.tail_nonzero(PAYLOAD_PATH),
            "hex": PRIMAL_HEX,
        }

        target = next((m for m in members if m.name.endswith(fs.UNSIGNED_COMPONENT)), None)
        if target is not None:
            data = fs.member_bytes(PAYLOAD_PATH, target)
            slices = fs.read_fat_slices(data)
            body = fs.slice_body(data, slices[0])
            sb = fs.parse_superblob(body)
            entry = {"name": fs.UNSIGNED_COMPONENT, "size": target.size}
            entry["slices"] = [
                {
                    "arch": s.arch,
                    "size": s.size,
                    "nonzero": fs.slice_nonzero(data, s),
                    "has_macho": fs.slice_has_macho(data, s),
                }
                for s in slices
            ]
            if sb is not None:
                entry["slots"] = {f"0x{k:X}": v for k, v in sorted(sb.slots.items())}
                entry["cms_present"] = sb.cms is not None
                if sb.code_directory:
                    good, bad, first_bad = fs.verify_page_hashes(body, sb.code_directory)
                    entry["pages"] = {
                        "good": good,
                        "bad": bad,
                        "first_bad_slot": first_bad,
                        "first_bad_offset": (first_bad * 4096) if first_bad is not None else None,
                    }
            report["unsigned_component"] = entry

        sealed = {}
        manifest_member = next(
            (m for m in members if m.name.endswith("_CodeSignature/CodeResources")), None
        )
        if manifest_member is not None:
            text = fs.member_bytes(PAYLOAD_PATH, manifest_member).decode("utf-8", "replace")
            sealed = fs.parse_code_resources(text)
            root = p.parent / "FL_Studio_Payload_Extracted" / "payload_root"
            audit = fs.audit_sealed(root, sealed) if root.is_dir() else None
            report["manifest"] = {
                "sealed": len(sealed),
                "symlinks": len(fs.symlinks(text)),
                "audit": audit,
            }
        return report
    except Exception as e:                       # noqa: BLE001
        logger.exception("payload analysis failed")
        return {"ok": False, "error": str(e)}


@app.route("/api/payload", methods=["GET"])
def payload_status():
    """Live analysis of the FL Studio payload (cpio, fat slices, signatures)."""
    report = _payload_report()
    return jsonify(report), (200 if report.get("ok") else 503)



# ---------------------------------------------------------------------------
# ABRASAX brain -- proxy to the synaptic-field service on :9626
# ---------------------------------------------------------------------------

BRAIN_URL = os.environ.get("ABRASAX_BRAIN", "http://127.0.0.1:9626")


@app.route("/api/brain/<what>", methods=["GET"])
def brain_proxy(what):
    """Proxy /api/brain/{state,texture,activity,health} to the brain service."""
    if what not in ("state", "texture", "activity", "health"):
        return jsonify({"error": f"unknown brain resource {what!r}"}), 404
    try:
        resp = _client.get(f"{BRAIN_URL}/{what}", timeout=15.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:                       # noqa: BLE001
        return jsonify({"error": str(e), "brain": BRAIN_URL}), 503


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("ABRASAX Web Chat Server starting...")
    logger.info(f"  Static dir: {STATIC_DIR}")
    logger.info(f"  Gateway:    {GATEWAY_URL}")
    logger.info(f"  Bind:       {HOST}:{PORT}")
    logger.info(f"  HEX:        {PRIMAL_HEX}")
    logger.info("=" * 60)
    logger.info(f"Open http://{HOST}:{PORT} in your browser to chat.")
    logger.info("=" * 60)

    app.run(host=HOST, port=PORT, debug=False)
