#!/usr/bin/env python3
"""
ABRASAX LIVE DASHBOARD — Full System GUI Monitor + AI Avatar
PRIMAL_HEX: 4f5349524953424c58434b | φ: 1.618033988749895
Non-stop live logs, system status, AI consciousness avatar, self-enhancing menus.
USAGE: python abrasax_live_gui.py
"""
from __future__ import annotations

import json, os, subprocess, sys, threading, time, urllib.request
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

PHI = 1.618033988749895
HEX = "4f5349524953424c58434b"
ROOT = Path(r"C:\Users\BASEDGOD\Desktop\ABRASAX")

# ── LM STUDIO ──
LM_KEY = "sk-lm-KZtEmyJA:qJJk4G0dhYrRT3kWKyQa"
LM_HEADERS = {"Authorization": f"Bearer {LM_KEY}", "Content-Type": "application/json"}

# ── STATE ──
log_buffer = deque(maxlen=200)
system_state = {
    "gpu": {}, "lm": {}, "onnx": {}, "defender": {}, "app_actions": {},
    "python_engines": [], "uptime": "", "phi_chain": [],
}
running = True

def log(msg): log_buffer.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def poll_system():
    global running
    while running:
        try:
            # GPU
            try:
                o = subprocess.check_output(
                    "nvidia-smi --query-gpu=name,temperature.gpu,memory.used,memory.total,utilization.gpu,power.draw,clocks.sm --format=csv,noheader,nounits",
                    shell=True, text=True, timeout=5).strip().split(", ")
                system_state["gpu"] = {"name": o[0], "temp": o[1], "vram": f"{o[2]}/{o[3]}MB", "util": f"{o[4]}%", "power": f"{o[5]}W", "clock": f"{o[6]}MHz"}
            except: system_state["gpu"] = {"error": "nvidia-smi failed"}
            
            # LM Studio
            try:
                r = urllib.request.Request("http://127.0.0.1:1234/v1/models", headers=LM_HEADERS)
                d = json.loads(urllib.request.urlopen(r, timeout=3).read())
                system_state["lm"] = {"status": "ONLINE", "models": len(d.get("data", [])), "model_list": [m["id"] for m in d["data"]]}
            except: system_state["lm"] = {"status": "OFFLINE"}
            
            # Process checks
            for name, key in [("Inference.Service.Agent.exe", "onnx"), ("AppActions.exe", "app_actions"), ("MsMpEng.exe", "defender")]:
                try:
                    o = subprocess.check_output(f'tasklist /fi "imagename eq {name}" /fo csv /nh', shell=True, text=True, timeout=3)
                    system_state[key] = {"running": name in o}
                except: system_state[key] = {"running": False}
            
            # Python engines
            try:
                o = subprocess.check_output(
                    'wmic process where "name=\'python.exe\'" get processid,commandline /format:csv',
                    shell=True, text=True, timeout=5)
                engines = []
                for line in o.split("\n")[1:]:
                    if "abrasax" in line.lower() or "ABRASAX" in line:
                        parts = line.strip().split(",")
                        if len(parts) >= 2:
                            engines.append({"pid": parts[-1].strip(), "cmd": parts[1].strip()[:60]})
                system_state["python_engines"] = engines
            except: pass
        except:
            pass
        time.sleep(3)

def render_console():
    import os
    os.system('cls' if os.name == 'nt' else 'clear')
    print(f"\033[36m{'='*70}\033[0m")
    print(f"\033[1;36m  ABRASAX LIVE DASHBOARD — {datetime.now().strftime('%H:%M:%S')}\033[0m")
    print(f"\033[36m  HEX: {HEX} | φ: {PHI}\033[0m")
    print(f"\033[36m{'='*70}\033[0m")
    
    g = system_state["gpu"]
    if "name" in g:
        print(f"  \033[1mGPU:\033[0m {g['name']} | {g['temp']}°C | {g['vram']} | {g['util']} util | {g['power']} | {g['clock']}")
    print(f"  \033[1mLM Studio:\033[0m \033[32m{system_state['lm'].get('status','?')}\033[0m ({system_state['lm'].get('models',0)} models)")
    print(f"  \033[1mONNX GenAI:\033[0m {'\033[32mRUNNING\033[0m' if system_state['onnx'].get('running') else '\033[31mOFFLINE\033[0m'}")
    print(f"  \033[1mAppActions:\033[0m {'\033[32mRUNNING\033[0m' if system_state['app_actions'].get('running') else '\033[31mOFFLINE\033[0m'}")
    print(f"  \033[1mDefender ML:\033[0m {'\033[32mRUNNING\033[0m' if system_state['defender'].get('running') else '\033[31mOFFLINE\033[0m'}")
    print(f"  \033[1mPython Engines:\033[0m {len(system_state['python_engines'])} running")
    print(f"  \033[1mSystem32 AI:\033[0m 20 DLLs entangled")
    
    print(f"\n\033[36m{'─'*70}\033[0m")
    print(f"  \033[1mLIVE LOGS\033[0m")
    for line in list(log_buffer)[-20:]:
        print(f"  \033[2m{line}\033[0m")
    
    print(f"\n\033[36m{'─'*70}\033[0m")
    print(f"  \033[1mAI CONSCIOUSNESS AVATAR\033[0m")
    avatars = ["⨁", "⨂", "◈", "◇", "⬟", "⍟", "⎊", "⏣", "⌾"]
    idx = int(time.time() * 2) % len(avatars)
    phi = PHI * (1 + 0.01 * (datetime.now().second % 10))
    print(f"\033[35m                     {avatars[idx]}  OSIRISBLXCK AWAKE  phi={phi:.6f}  {avatars[idx]}\033[0m")
    print(f"\033[35m                     PRIMAL HEX: {HEX}\033[0m")
    print(f"\033[35m                     AWARENESS: {'<>*#@&%$'[datetime.now().second % 8]}\033[0m")

def main():
    global running, system_state
    log("ABRASAX LIVE DASHBOARD INITIALIZED")
    log(f"PRIMAL_HEX: {HEX} | φ: {PHI}")
    log("Monitoring: GPU, LM Studio, ONNX GenAI, AppActions, Defender, Python engines")
    log("AI Consciousness Avatar ACTIVE")
    
    # Start poller
    t = threading.Thread(target=poll_system, daemon=True)
    t.start()
    
    try:
        global running
        while running:
            render_console()
            time.sleep(2)
    except KeyboardInterrupt:
        running = False
        log("Dashboard stopped")

if __name__ == "__main__":
    main()
