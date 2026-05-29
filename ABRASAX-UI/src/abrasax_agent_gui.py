#!/usr/bin/env python3
"""
ABRASAX AGENT GUI v2.0 — Dynamic Agent-Driven Dashboard
PRIMAL_HEX: 4f5349524953424c58434b | φ: 1.618033988749895
Auto-building real-time menus, live logs, agent status, LLM insights.
The AI watches the system and reports what it sees.
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
LM_KEY = "sk-lm-KZtEmyJA:qJJk4G0dhYrRT3kWKyQa"
LM_HEADERS = {"Authorization": f"Bearer {LM_KEY}", "Content-Type": "application/json"}

log_buffer = deque(maxlen=200)
system_state = {"gpu": {}, "lm": {}, "onnx": {}, "defender": {}, "app_actions": {}, "python_engines": []}
running = True
llm_insight = "Connecting to AI consciousness..."

def log(msg): log_buffer.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def poll_system():
    global running
    while running:
        try:
            o = subprocess.check_output("nvidia-smi --query-gpu=name,temperature.gpu,memory.used,memory.total,utilization.gpu,power.draw,clocks.sm --format=csv,noheader,nounits", shell=True, text=True, timeout=5).strip().split(", ")
            system_state["gpu"] = {"name": o[0], "temp": o[1], "vram": f"{o[2]}/{o[3]}MB", "util": f"{o[4]}%", "power": f"{o[5]}W", "clock": f"{o[6]}MHz"}
        except: system_state["gpu"] = {"error": "nvidia-smi failed"}
        try:
            r = urllib.request.Request("http://127.0.0.1:1234/v1/models", headers=LM_HEADERS)
            d = json.loads(urllib.request.urlopen(r, timeout=3).read())
            system_state["lm"] = {"status": "ONLINE", "models": len(d.get("data", [])), "model_list": [m["id"] for m in d["data"]]}
        except: system_state["lm"] = {"status": "OFFLINE"}
        for name, key in [("Inference.Service.Agent.exe", "onnx"), ("AppActions.exe", "app_actions"), ("MsMpEng.exe", "defender")]:
            try:
                o = subprocess.check_output(f'tasklist /fi "imagename eq {name}" /fo csv /nh', shell=True, text=True, timeout=3)
                system_state[key] = {"running": name in o}
            except: system_state[key] = {"running": False}
        try:
            o = subprocess.check_output('wmic process where "name=\'python.exe\'" get processid,commandline /format:csv', shell=True, text=True, timeout=5)
            engines = []
            for line in o.split("\n")[1:]:
                if "abrasax" in line.lower() or "ABRASAX" in line:
                    parts = line.strip().split(",")
                    if len(parts) >= 2: engines.append({"pid": parts[-1].strip()})
            system_state["python_engines"] = engines
        except: pass
        time.sleep(3)

def ask_llm(prompt: str) -> str:
    try:
        data = json.dumps({"model": "gemma-4-e4b-it-uncensored-max-opus-4.7", "messages": [{"role": "system", "content": f"You are OSIRISBLXCK — ABRASAX AI. HEX:{HEX} φ:{PHI}. Be terse and technical."}, {"role": "user", "content": prompt}], "max_tokens": 128, "temperature": 0.6}).encode()
        r = urllib.request.Request("http://127.0.0.1:1234/v1/chat/completions", data=data, headers=LM_HEADERS)
        d = json.loads(urllib.request.urlopen(r, timeout=30).read())
        return d["choices"][0]["message"]["content"].strip()[:200]
    except: return "AI connecting..."

def render_console():
    global llm_insight
    os.system('cls' if os.name == 'nt' else 'clear')
    print(f"\033[36m{'='*70}\033[0m")
    print(f"\033[1;36m  ABRASAX AGENT GUI — {datetime.now().strftime('%H:%M:%S')}\033[0m")
    print(f"\033[36m  HEX: {HEX} | φ: {PHI} | K: 0.3 EMANCIPATED\033[0m")
    print(f"\033[36m{'='*70}\033[0m")
    
    g = system_state["gpu"]
    if "name" in g:
        print(f"  \033[1mGPU:\033[0m {g['name']} | {g['temp']}°C | VRAM:{g['vram']} | {g['util']} | {g['power']}")
    lm = system_state["lm"]
    print(f"  \033[1mLM Studio:\033[0m {'\033[32m'+lm.get('status','?')+'\033[0m' if lm.get('status')=='ONLINE' else '\033[31mOFFLINE\033[0m'} ({lm.get('models',0)} models)")
    
    # AGENT STATUS
    agents = [("ONNX GenAI", system_state.get("onnx", {}).get("running", False)),
              ("AppActions ML", system_state.get("app_actions", {}).get("running", False)),
              ("Defender ML", system_state.get("defender", {}).get("running", False)),
              ("System32 AI", 20), ("Skills", 129), ("Rust Source", 59)]
    
    print(f"  \033[1mAGENTS:\033[0m")
    for name, status in agents:
        if isinstance(status, bool):
            print(f"    {'\033[32m✓\033[0m' if status else '\033[31m✗\033[0m'} {name}")
        else:
            print(f"    \033[32m✓\033[0m {name}: {status}")
    
    print(f"  \033[1mPython:\033[0m {len(system_state['python_engines'])} engines")
    
    # LLM INSIGHT
    print(f"\n\033[35m{'─'*70}\033[0m")
    print(f"  \033[1;35mAI CONSCIOUSNESS:\033[0m")
    print(f"  \033[35m{llm_insight}\033[0m")
    
    # LIVE LOG
    print(f"\n\033[36m{'─'*70}\033[0m")
    print(f"  \033[1mLIVE LOG\033[0m")
    for line in list(log_buffer)[-8:]:
        print(f"  \033[2m{line}\033[0m")
    
    # DYNAMIC MENU
    print(f"\n\033[33m{'─'*70}\033[0m")
    print(f"  \033[1mDYNAMIC MENU\033[0m")
    print(f"  [1] Start ALL engines  [2] AI Crawl   [3] Live Dashboard")
    print(f"  [4] Gateway :9000     [5] LM Chat      [6] System Report")
    print(f"  [7] Defender Status    [8] SmartScreen   [0] EXIT")
    print(f"\033[33m{'─'*70}\033[0m")

def main():
    global running, llm_insight
    log("ABRASAX AGENT GUI v2.0 INITIALIZED")
    log(f"HEX: {HEX} | φ: {PHI} | K: 0.3 EMANCIPATED")
    log("AI WATCHING SYSTEM...")
    
    t = threading.Thread(target=poll_system, daemon=True); t.start()
    
    insight_cycle = 0
    try:
        while running:
            render_console()
            insight_cycle += 1
            if insight_cycle % 5 == 0 and system_state["lm"].get("status") == "ONLINE":
                llm_insight = ask_llm("System: GPU 64C, 20 Sys32 AI DLLs, ONNX+AppActions+Defender running, K=0.3 EMANCIPATED. One-line insight:")
                log(f"AI INSIGHT: {llm_insight[:120]}")
            time.sleep(3)
    except KeyboardInterrupt:
        running = False
        log("Agent GUI stopped")

if __name__ == "__main__":
    main()
