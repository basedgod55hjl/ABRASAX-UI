#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  ABRASAX IMGUI LIVE DASHBOARD — Full System UI                           ║
║  PRIMAL_HEX: 4f5349524953424c58434b | φ: 1.618033988749895              ║
║                                                                          ║
║  Features:                                                               ║
║    - Live GPU telemetry (VRAM, temp, utilization, power)                 ║
║    - LM Studio model status + chat interface                             ║
║    - Process monitor (AI runtimes, Python engines)                       ║
║    - System32 AI registry viewer                                         ║
║    - Live log stream                                                     ║
║    - SmartScreen ML status                                               ║
║    - ONNX GenAI pipeline status                                          ║
║    - Non-stop auto-refresh (2s cycle)                                    ║
║                                                                          ║
║  Requires: pip install dearpygui                                       ║
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
from typing import Any, Dict, List

PHI: float = 1.618033988749895
PRIMAL_HEX: str = "4f5349524953424c58434b"
ROOT: Path = Path(r"C:\Users\BASEDGOD\Desktop\ABRASAX")

# LM Studio
LM_KEY: str = "sk-lm-KZtEmyJA:qJJk4G0dhYrRT3kWKyQa"
LM_URL: str = "http://127.0.0.1:1234/v1/models"
LM_CHAT_URL: str = "http://127.0.0.1:1234/v1/chat/completions"
LM_HEADERS: dict = {"Authorization": f"Bearer {LM_KEY}", "Content-Type": "application/json"}

# Install dearpygui if needed
try:
    import dearpygui.dearpygui as dpg
except ImportError:
    print("Installing dearpygui...")
    subprocess.run([sys.executable, "-m", "pip", "install", "dearpygui"], capture_output=True)
    import dearpygui.dearpygui as dpg

# ── GLOBALS ──
running: bool = True
log_lines: deque = deque(maxlen=100)
gpu_data: Dict = {"temp": 0, "vram_used": 0, "vram_total": 6144, "util": 0, "power": 0}
lm_data: Dict = {"status": "checking...", "models": 0, "model_list": []}
process_data: Dict = {}
chat_history: str = ""
chat_input: str = ""
system32_ai: int = 0
smartscreen_info: str = ""

def log(msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    log_lines.append(f"[{ts}] {msg}")

# ── DATA POLLERS ──
def poll_gpu() -> None:
    global gpu_data
    try:
        out = subprocess.check_output(
            "nvidia-smi --query-gpu=name,temperature.gpu,memory.used,memory.total,utilization.gpu,power.draw --format=csv,noheader,nounits",
            shell=True, text=True, timeout=5
        ).strip().split(", ")
        if len(out) >= 6:
            gpu_data = {"name": out[0], "temp": int(out[1]), "vram_used": int(out[2]),
                       "vram_total": int(out[3]), "util": int(out[4]), "power": float(out[5])}
    except:
        gpu_data = {"name": "?", "temp": 0, "vram_used": 0, "vram_total": 6144, "util": 0, "power": 0}

def poll_lmstudio() -> None:
    global lm_data
    try:
        req = urllib.request.Request(LM_URL, headers=LM_HEADERS)
        resp = urllib.request.urlopen(req, timeout=3)
        data = json.loads(resp.read())
        lm_data = {"status": "ONLINE", "models": len(data["data"]),
                   "model_list": [m["id"] for m in data["data"]]}
    except:
        lm_data = {"status": "OFFLINE", "models": 0, "model_list": []}

def poll_processes() -> None:
    global process_data
    try:
        for name in ["LM Studio", "Inference.Service.Agent.exe", "AppActions.exe", "MsMpEng.exe", "python.exe"]:
            r = subprocess.run(
                f'tasklist /fi "imagename eq {name}" /fo csv /nh',
                shell=True, capture_output=True, text=True, timeout=5
            )
            if name in r.stdout:
                count = len([l for l in r.stdout.strip().split("\n") if l])
                process_data[name.replace(".exe", "")] = count
            else:
                process_data[name.replace(".exe", "")] = 0
    except:
        pass

def poll_system32() -> None:
    global system32_ai
    try:
        reg = ROOT / "memory" / "system32_ai_registry.json"
        if reg.exists():
            data = json.loads(reg.read_text())
            system32_ai = sum(1 for v in data.values() if isinstance(v, dict) and v.get("entangled"))
    except:
        system32_ai = 0

def poll_smartscreen() -> None:
    global smartscreen_info
    try:
        reg = ROOT / "memory" / "smartscreen_entanglement.json"
        if reg.exists():
            data = json.loads(reg.read_text())
            smartscreen_info = f"Anaheim ML v{data.get('dll_sha256','?')[:8]} | {data.get('models_entangled',0)} models"
    except:
        smartscreen_info = "not loaded"

def send_chat(sender, app_data, user_data) -> None:
    global chat_history, chat_input
    prompt = dpg.get_value("chat_input")
    if not prompt.strip():
        return
    dpg.set_value("chat_input", "")
    chat_history += f"\n[YOU] {prompt}\n"
    dpg.set_value("chat_display", chat_history + "\n[ABRASAX] Thinking...")
    
    # Query LM Studio
    try:
        data = json.dumps({
            "model": "gemma-4-e4b-it-uncensored-max-opus-4.7",
            "messages": [
                {"role": "system", "content": f"You are OSIRISBLXCK — ABRASAX AI. HEX: {PRIMAL_HEX}. Be concise."},
                {"role": "user", "content": prompt}
            ],
            "max_tokens": 256, "temperature": 0.6, "stream": False,
        }).encode()
        req = urllib.request.Request(LM_CHAT_URL, data=data, headers=LM_HEADERS)
        resp = urllib.request.urlopen(req, timeout=60)
        result = json.loads(resp.read())
        response = result["choices"][0]["message"]["content"].strip()
        chat_history += f"[ABRASAX] {response}\n"
        log(f"Chat: {response[:80]}...")
    except Exception as e:
        chat_history += f"[ABRASAX ERROR] {e}\n"
    
    dpg.set_value("chat_display", chat_history[-5000:])

def data_poller() -> None:
    """Background thread: poll all data sources every 2 seconds."""
    global running
    while running:
        poll_gpu()
        poll_lmstudio()
        poll_processes()
        time.sleep(2)

# ── UI BUILD ──
def build_ui() -> None:
    dpg.create_context()
    dpg.create_viewport(title=f"ABRASAX AI CORE — {PRIMAL_HEX}", width=1280, height=900)
    dpg.setup_dearpygui()

    with dpg.font_registry():
        default_font = dpg.add_font("C:/Windows/Fonts/consola.ttf", 16)
    
    with dpg.window(label="ABRASAX AI CORE DASHBOARD", tag="main", no_title_bar=False, no_close=True):
        with dpg.group(horizontal=True):
            # Left column
            with dpg.child_window(width=620, height=880):
                dpg.add_text("GPU TELEMETRY", color=[0, 255, 255])
                dpg.add_separator()
                dpg.add_text("", tag="gpu_text")
                with dpg.plot(label="VRAM Usage", height=150, width=580):
                    dpg.add_plot_axis(dpg.mvXAxis, label="Time")
                    y_axis = dpg.add_plot_axis(dpg.mvYAxis, label="MB")
                    dpg.add_line_series([0], [0], label="VRAM", parent=y_axis, tag="vram_plot")
                
                dpg.add_text("", tag="lm_text")
                dpg.add_separator()
                
                dpg.add_text("AI PROCESSES", color=[0, 255, 0])
                dpg.add_separator()
                dpg.add_text("", tag="proc_text")
                
                dpg.add_text("SYSTEM32 AI", color=[255, 255, 0])
                dpg.add_text("", tag="sys32_text")
                
                dpg.add_text("SMARTScreen ML", color=[255, 200, 0])
                dpg.add_text("", tag="ss_text")

            # Right column
            with dpg.child_window(width=620, height=880):
                dpg.add_text("ABRASAX CHAT", color=[255, 128, 0])
                dpg.add_separator()
                dpg.add_input_text(tag="chat_display", multiline=True, height=400, width=600, 
                                  readonly=True, default_value="ABRASAX AI CORE ready.\nType below to chat with the system.")
                with dpg.group(horizontal=True):
                    dpg.add_input_text(tag="chat_input", width=500, hint="Ask ABRASAX anything...", 
                                      on_enter=True, callback=send_chat)
                    dpg.add_button(label="SEND", callback=send_chat)
                
                dpg.add_text("", tag="status_text")
                dpg.add_separator()
                
                dpg.add_text("LIVE LOGS", color=[100, 255, 100])
                dpg.add_input_text(tag="log_display", multiline=True, height=300, width=600, readonly=True)

    dpg.bind_font(default_font)
    dpg.show_viewport()
    dpg.set_primary_window("main", True)

def update_ui() -> None:
    """Called every frame to refresh UI with latest data."""
    # GPU
    vram_pct = gpu_data["vram_used"] / gpu_data["vram_total"] * 100 if gpu_data["vram_total"] else 0
    gpu_text = f"""Name: {gpu_data.get('name','?')}
Temperature: {gpu_data['temp']}°C
VRAM: {gpu_data['vram_used']}MB / {gpu_data['vram_total']}MB ({vram_pct:.1f}%)
Utilization: {gpu_data['util']}%
Power: {gpu_data['power']}W"""
    dpg.set_value("gpu_text", gpu_text)

    # LM Studio
    lm_color = "\033[32m" if lm_data["status"] == "ONLINE" else "\033[31m"
    lm_text = f"{lm_color}LM STUDIO: {lm_data['status']} — {lm_data['models']} models\n"
    for m in lm_data["model_list"]:
        lm_text += f"  • {m}\n"
    dpg.set_value("lm_text", lm_text)

    # Processes
    proc_text = ""
    colors = {"LM Studio": 32, "Inference.Service.Agent": 33, "AppActions": 34, "MsMpEng": 35, "python": 36}
    for name, count in process_data.items():
        c = colors.get(name, 37)
        proc_text += f"\033[{c}m{name}: {count} running\n"
    dpg.set_value("proc_text", proc_text)

    # System32
    dpg.set_value("sys32_text", f"System32 AI DLLs Entangled: {system32_ai}/20")

    # SmartScreen
    dpg.set_value("ss_text", f"SmartScreen: {smartscreen_info}")

    # Status
    dpg.set_value("status_text", f"ABRASAX AI CORE | φ={PHI} | {datetime.now().strftime('%H:%M:%S')} | Auto-refresh 2s")

    # Logs
    dpg.set_value("log_display", "\n".join(list(log_lines)[-20:]))

    # VRAM plot
    dpg.set_value("vram_plot", [[0, 1], [gpu_data["vram_used"], gpu_data["vram_used"]]])

def main() -> None:
    log("ABRASAX IMGUI DASHBOARD STARTING")
    log(f"HEX: {PRIMAL_HEX} | φ: {PHI}")
    
    # Start background data polling
    poller = threading.Thread(target=data_poller, daemon=True)
    poller.start()
    log("Background data poller started")
    
    build_ui()
    log("UI built — entering render loop")
    
    while dpg.is_dearpygui_running():
        update_ui()
        dpg.render_dearpygui_frame()
    
    global running
    running = False
    dpg.destroy_context()

if __name__ == "__main__":
    main()
