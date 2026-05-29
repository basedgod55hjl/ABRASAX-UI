#!/usr/bin/env python3
"""
ABRASAX — Live Logging System
Continuously monitors all AI runtimes + ABRASAX engines + system state.
Writes to: logs/live_feed.log
Displays: Real-time console dashboard
"""
import json, os, subprocess, sys, time, urllib.request
from datetime import datetime
from pathlib import Path
from collections import deque

ROOT = Path(r"C:\Users\BASEDGOD\Desktop\ABRASAX")
LOG_DIR = ROOT / "logs"
DATA_LOG = ROOT / "data" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
DATA_LOG.mkdir(parents=True, exist_ok=True)

LIVE_FEED = DATA_LOG / "live_feed.log"
CURRENT_LOG = LOG_DIR / "current_session.log"

API_KEY = "sk-lm-KZtEmyJA:qJJk4G0dhYrRT3kWKyQa"
API_HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

history = deque(maxlen=50)

def log(msg, tag="LIVE"):
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    line = f"[{ts}] [{tag}] {msg}"
    history.append(line)
    print(line, flush=True)
    for p in [LIVE_FEED, CURRENT_LOG]:
        try:
            with open(p, "a", encoding="utf-8") as f:
                f.write(f"{datetime.now().isoformat()} {line}\n")
        except:
            pass

def poll_gpu():
    try:
        o = subprocess.check_output("nvidia-smi --query-gpu=temperature.gpu,memory.used,memory.total,utilization.gpu,power.draw --format=csv,noheader,nounits", shell=True, text=True, timeout=5).strip().split(", ")
        return {"temp":o[0],"vram":f"{o[1]}/{o[2]}MB","util":f"{o[3]}%","power":f"{o[4]}W"}
    except: return {"error":"nvidia-smi failed"}

def poll_lm():
    try:
        r = urllib.request.Request("http://127.0.0.1:1234/v1/models", headers=API_HEADERS)
        d = json.loads(urllib.request.urlopen(r, timeout=3).read())
        return {"status":"ONLINE","models":len(d.get("data",[]))}
    except: return {"status":"OFFLINE"}

def poll_process(name):
    try:
        o = subprocess.check_output(f'tasklist /fi "imagename eq {name}" /fo csv /nh', shell=True, text=True, timeout=5)
        if name in o:
            import re; m = re.search(r'"(\d+)"', o)
            return {"running":True,"pid":int(m.group(1)) if m else 0}
        return {"running":False}
    except: return {"running":False}

def main():
    log("═══ ABRASAX LIVE LOG — STARTED ═══", "BOOT")
    log(f"PRIMAL_HEX: 4f5349524953424c58434b | φ: 1.618033988749895", "BOOT")
    log("Monitoring: LM Studio, ONNX GenAI, AppActions, Defender ML, GPU, Python engines", "BOOT")
    
    while True:
        ts = datetime.now().strftime("%H:%M:%S")
        gpu = poll_gpu()
        lm = poll_lm()
        
        # Quick status line
        status = f"[{ts}] "
        status += f"GPU:{gpu.get('temp','?')}°C {gpu.get('vram','?')} {gpu.get('util','?')} "
        status += f"| LM:{lm['status']}({lm.get('models',0)} models) "
        for name in ["Inference.Service.Agent.exe","AppActions.exe","MsMpEng.exe"]:
            p = poll_process(name)
            short = name.split(".")[0][:12]
            status += f"| {short}:{'UP' if p['running'] else 'DN'}"
        
        log(status, "STATUS")
        time.sleep(10)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("═══ LIVE LOG STOPPED ═══", "SHUTDOWN")
