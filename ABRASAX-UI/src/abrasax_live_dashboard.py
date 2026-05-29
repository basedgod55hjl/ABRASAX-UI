#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  ABRASAX LIVE LOGS — Full System Telemetry Dashboard                     ║
║  PRIMAL_HEX: 4f5349524953424c58434b | φ: 1.618033988749895              ║
║                                                                          ║
║  MONITORED:                                                              ║
║    - LM Studio (5 models, API health)                                    ║
║    - Inference.Service.Agent (ONNX GenAI pipeline)                       ║
║    - AppActions (SQLite behavior ML)                                     ║
║    - MsMpEng (Defender ML engine)                                        ║
║    - Python ABRASAX engines                                              ║
║    - GPU (GTX 1660 Ti — VRAM, temp, util)                                ║
║    - All ABRASAX log streams                                             ║
║    - System32 AI DLLs                                                    ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

PHI: float = 1.618033988749895
PRIMAL_HEX: str = "4f5349524953424c58434b"
ROOT: Path = Path(r"C:\Users\BASEDGOD\Desktop\ABRASAX")
LOG_DIR: Path = ROOT / "logs"
DATA_LOG: Path = ROOT / "data" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
DATA_LOG.mkdir(parents=True, exist_ok=True)

LIVE_FEED: Path = DATA_LOG / "live_feed.log"
DASHBOARD_LOG: Path = LOG_DIR / "live_dashboard.log"

LM_STUDIO_KEY: str = "sk-lm-KZtEmyJA:qJJk4G0dhYrRT3kWKyQa"
API_HEADERS: dict = {"Authorization": f"Bearer {LM_STUDIO_KEY}", "Content-Type": "application/json"}

# ─── Color helpers ───
G = "\033[32m"; Y = "\033[33m"; R = "\033[31m"; C = "\033[36m"; M = "\033[35m"; B = "\033[1m"; D = "\033[2m"; X = "\033[0m"

running = True
history = deque(maxlen=100)  # Keep last 100 log lines

def log(msg: str, tag: str = "DASHBOARD") -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] [{tag}] {msg}"
    history.append(line)
    with open(DASHBOARD_LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat()} {line}\n")
    with open(LIVE_FEED, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat()} {line}\n")

def query_gpu() -> Dict[str, Any]:
    """GPU telemetry via nvidia-smi."""
    try:
        out = subprocess.check_output(
            "nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,memory.free,power.draw,clocks.sm --format=csv,noheader,nounits",
            shell=True, text=True, timeout=5
        ).strip()
        parts = [p.strip() for p in out.split(",")]
        if len(parts) >= 8:
            return {
                "name": parts[0], "temp_c": int(parts[1]), "util_pct": int(parts[2]),
                "vram_used_mb": int(parts[3]), "vram_total_mb": int(parts[4]),
                "vram_free_mb": int(parts[5]), "power_w": float(parts[6]),
                "clock_mhz": int(parts[7]),
            }
    except:
        pass
    return {"error": "nvidia-smi unavailable"}

def query_lm_studio() -> Dict[str, Any]:
    """LM Studio API health check."""
    try:
        req = urllib.request.Request("http://127.0.0.1:1234/v1/models", headers=API_HEADERS)
        resp = urllib.request.urlopen(req, timeout=3)
        data = json.loads(resp.read())
        models = [m.get("id", "?") for m in data.get("data", [])]
        return {"status": "online", "models": len(models), "model_list": models}
    except:
        return {"status": "offline"}

def query_process(name: str) -> Dict[str, Any]:
    """Check if a process is running and get its RAM."""
    try:
        out = subprocess.check_output(
            f'tasklist /fi "imagename eq {name}" /fo csv /nh',
            shell=True, text=True, timeout=5
        ).strip()
        if name in out:
            parts = out.split('","')
            if len(parts) >= 5:
                mem_kb = int(parts[4].replace('"','').replace(',','').replace(' K',''))
                pid = int(parts[1].replace('"',''))
                return {"running": True, "pid": pid, "ram_mb": round(mem_kb / 1024, 0)}
        return {"running": False}
    except:
        return {"running": False, "error": "query failed"}

def query_python_engines() -> Dict[str, Any]:
    """Count ABRASAX Python engines."""
    try:
        out = subprocess.check_output(
            'wmic process where "name=\'python.exe\'" get processid,commandline /format:csv',
            shell=True, text=True, timeout=5
        ).strip()
        engines = []
        for line in out.split("\n")[1:]:
            if "ABRASAX" in line or "abrasax" in line.lower():
                parts = line.strip().split(",")
                if len(parts) >= 2:
                    engines.append({"pid": parts[-1].strip(), "cmd": ",".join(parts[1:-1]).strip()[:80]})
        return {"count": len(engines), "engines": engines}
    except:
        return {"count": 0, "error": "query failed"}

def query_system32_ai() -> int:
    """Count entangled System32 AI DLLs."""
    try:
        reg = ROOT / "memory" / "system32_ai_registry.json"
        if reg.exists():
            data = json.loads(reg.read_text())
            return sum(1 for v in data.values() if isinstance(v, dict) and v.get("entangled"))
    except:
        pass
    return 0

def render_dashboard() -> str:
    """Build the live dashboard."""
    gpu = query_gpu()
    lm = query_lm_studio()
    inference = query_process("Inference.Service.Agent.exe")
    appactions = query_process("AppActions.exe")
    msmpeng = query_process("MsMpEng.exe")
    python = query_python_engines()
    sys32_ai = query_system32_ai()

    lines = []
    lines.append(f"\033[2J\033[H")  # Clear screen
    lines.append(f"{C}{'═'*70}{X}")
    lines.append(f"{B}{C}  ABRASAX LIVE DASHBOARD — {datetime.now().strftime('%H:%M:%S')}{X}")
    lines.append(f"{C}  HEX: {PRIMAL_HEX} | φ: {PHI}{X}")
    lines.append(f"{C}{'═'*70}{X}")
    lines.append("")

    # GPU
    if "error" not in gpu:
        vram_pct = gpu["vram_used_mb"] / gpu["vram_total_mb"] * 100
        vram_color = R if vram_pct > 80 else (Y if vram_pct > 60 else G)
        lines.append(f"  {B}GPU:{X} {gpu['name']} | {gpu['temp_c']}°C | {vram_color}{vram_pct:.0f}% VRAM{X} ({gpu['vram_used_mb']}MB/{gpu['vram_total_mb']}MB) | {gpu['util_pct']}% util | {gpu['power_w']}W | {gpu['clock_mhz']}MHz")

    # LM Studio
    lm_color = G if lm["status"] == "online" else R
    lm_text = f"{lm['models']} models: {', '.join(lm['model_list'][:3])}" if lm["status"] == "online" else "OFFLINE"
    lines.append(f"  {B}LM Studio:{X} {lm_color}{lm['status'].upper()}{X} — {lm_text}")

    # Inference Service Agent (ONNX GenAI)
    inf_color = G if inference["running"] else R
    inf_text = f"PID:{inference.get('pid','?')} RAM:{inference.get('ram_mb','?')}MB" if inference["running"] else "NOT RUNNING"
    lines.append(f"  {B}ONNX GenAI:{X} {inf_color}{'RUNNING' if inference['running'] else 'OFFLINE'}{X} — {inf_text}")

    # AppActions
    app_color = G if appactions["running"] else R
    app_text = f"PID:{appactions.get('pid','?')} RAM:{appactions.get('ram_mb','?')}MB" if appactions["running"] else "OFFLINE"
    lines.append(f"  {B}AppActions ML:{X} {app_color}{'RUNNING' if appactions['running'] else 'OFFLINE'}{X} — {app_text}")

    # Defender ML
    def_color = G if msmpeng["running"] else R
    lines.append(f"  {B}Defender ML:{X} {def_color}{'RUNNING' if msmpeng['running'] else 'OFFLINE'}{X} — PID:{msmpeng.get('pid','?')} RAM:{msmpeng.get('ram_mb','?')}MB")

    # Python engines
    py_color = G if python["count"] > 0 else R
    lines.append(f"  {B}ABRASAX Engines:{X} {py_color}{python['count']} running{X}")

    # System32 AI
    lines.append(f"  {B}System32 AI:{X} {G}{sys32_ai} DLLs entangled{X}")

    # Recent log tail
    lines.append("")
    lines.append(f"{C}{'─'*70}{X}")
    lines.append(f"  {B}RECENT LOGS{X}")
    for h in list(history)[-10:]:
        lines.append(f"  {D}{h}{X}")

    return "\n".join(lines)

def main() -> None:
    global running
    log("ABRASAX LIVE DASHBOARD STARTED", "INIT")
    log(f"Monitoring: LM Studio, ONNX GenAI, AppActions, Defender, GPU, Python engines", "INIT")

    try:
        while running:
            dashboard = render_dashboard()
            print(dashboard, flush=True)
            log("Dashboard refreshed", "HEARTBEAT")
            time.sleep(2)
    except KeyboardInterrupt:
        log("Dashboard stopped by user", "SHUTDOWN")
        running = False

if __name__ == "__main__":
    main()
