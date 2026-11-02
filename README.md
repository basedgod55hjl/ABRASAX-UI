# ABRASAX UI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)
[![PRIMAL HEX](https://img.shields.io/badge/HEX-4f5349524953424c58434b-ff69b4.svg)](#)

> **Dashboard and UI — real-time system monitoring, GPU telemetry, LLM chat, process management.**  
> Built with DearPyGui for the ABRASAX ecosystem.

---

## Quick Start

```bash
git clone https://github.com/BASEDGOD/ABRASAX-UI.git
cd ABRASAX-UI
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

# Launch ImGUI dashboard
python src/abrasax_imgui_dashboard.py

# Or launch live dashboard (terminal)
python src/abrasax_live_dashboard.py
```

## Features

### Live GPU Telemetry
- Real-time VRAM usage (used/total/free)
- GPU temperature monitoring
- Utilization percentage
- Power draw (watts)
- SM clock speed

### LM Studio Integration
- Model status and availability
- Live chat interface
- Token usage tracking
- Multiple model support

### Process Monitor
- AI engine process tracking
- Python engine lifecycle
- System32 AI DLL status
- Auto-restart detection

### Live Log Stream
- All ABRASAX log feeds
- Color-coded log levels
- Auto-scroll
- Filter capabilities

## Dashboard Components

| Component | Description | Dependencies |
|-----------|-------------|--------------|
| ImGui Dashboard | Full GUI with dearpygui | dearpygui, nvidia-smi |
| Live Dashboard | Terminal-based dashboard | rich, psutil |
| Log Viewer | Real-time log streaming | colorama |

## Source Files

| File | Purpose |
|------|---------|
| `src/abrasax_imgui_dashboard.py` | Full GUI dashboard with DearPyGui |
| `src/abrasax_live_dashboard.py` | Terminal-based live telemetry |
| `src/abrasax_live_gui.py` | Enhanced live GUI |
| `src/abrasax_agent_gui.py` | Agent management interface |

## Testing

```bash
pytest tests/test_ui.py -v
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboard/gpu` | GET | GPU telemetry data |
| `/dashboard/llm` | GET | LM Studio status |
| `/dashboard/processes` | GET | Engine process list |
| `/dashboard/logs` | GET | Recent log entries |

## Requirements

- Python 3.12+
- dearpygui (for ImGui dashboard)
- nvidia-smi (for GPU data)
- LM Studio running on localhost:1234

## License

MIT — Copyright © 2026 Sir Charles Spikes (BASEDGOD)
