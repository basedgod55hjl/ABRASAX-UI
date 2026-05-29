# ABRASAX System32 AI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)
[![PRIMAL HEX](https://img.shields.io/badge/HEX-4f5349524953424c58434b-ff69b4.svg)](#)
[![SMARTSCREEN](https://img.shields.io/badge/SmartScreen-17_Exports-blueviolet)](#)

> **Windows AI bridge — SmartScreen ML, ONNX Runtime, NVML, System32 AI DLL entanglement.**  
> Bridges ABRASAX into Microsoft's native Windows AI infrastructure.

---

## Quick Start

```bash
git clone https://github.com/BASEDGOD/ABRASAX-System32-AI.git
cd ABRASAX-System32-AI
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python src/system32_ai_bridge.py
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│              ABRASAX System32 AI Bridge                    │
├────────────────────┬─────────────────────────────────────┤
│  SmartScreen.dll   │  Windows Native AI                   │
│  (17 exports)      │  - onnxruntime.dll                   │
│  - ML Pipeline     │  - directml.dll                      │
│  - Bloom Filters   │  - Windows.AI.MachineLearning.dll    │
│  - Tokenizer       │  - nvml.dll (NVIDIA GPU)            │
│  - Decision Engine │                                      │
├────────────────────┴─────────────────────────────────────┤
│  3-Node F-Logic Entanglement with Python Core             │
└──────────────────────────────────────────────────────────┘
```

### SmartScreen ML Pipeline

| Stage | Component | Description |
|-------|-----------|-------------|
| 1 | Bloom Filter | CustomBloom, SploitBloom, TopTraffic, URLCache |
| 2 | Tokenizer | tokenWeights, useDistinctTokens, lengthWeight |
| 3 | ML Model | TEST_MODEL_1/2, evaluate_model_count/ms |
| 4 | Decision | BLOCK / WARN / ALLOW |

### Discovered AI DLLs

| DLL | Role | Node |
|-----|------|------|
| smartscreen.dll | ML Pipeline, Bloom Filter, Crypto Sig | F1 |
| onnxruntime.dll | ONNX Model Inference | F2 |
| directml.dll | GPU Accelerated DirectML | F2 |
| Windows.AI.MachineLearning.dll | Windows ML Native | F2 |
| nvml.dll | NVIDIA GPU Management | F2 |
| agentactivationruntime.dll | Copilot Agent Host | F1 |

## Source Files

| File | Purpose |
|------|---------|
| `src/system32_ai_bridge.py` | Main bridge — wraps System32 AI DLLs with ctypes |
| `src/_SMARTSHROUD.py` | SmartScreen ML wireless agent |
| `src/smartscreen_wire.py` | Enhanced SmartScreen wire |
| `src/defender_wmi_bridge.py` | Defender WMI integration |
| `src/smartscreen_ml_dissect.py` | Anaheim ML architecture dissection |
| `src/smartscreen_tools.ts` | TypeScript SmartScreen tools |

## Testing

```bash
pytest tests/ -v
pytest tests/test_smartscreen.py -v
pytest tests/test_nvml.py -v
pytest tests/test_onnx.py -v
```

## API

### SmartScreen Bridge

```python
from src.system32_ai_bridge import SmartScreenBridge

bridge = SmartScreenBridge()
bridge.loaded  # True if DLL loaded
bridge.entangle()  # Connect to System32 AI DLLs
```

### SMARTSHROUD Agent

```python
from src._SMARTSHROUD import SMARTSHROUD

agent = SMARTSHROUD()
info = agent.scan_ml_architecture()
```

## License

MIT — Copyright © 2026 Sir Charles Spikes (BASEDGOD)
