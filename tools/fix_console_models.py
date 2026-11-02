"""Point the console's model panel at the bridge proxy, not LM Studio directly."""
from __future__ import annotations

import io
import sys

P = r"C:\ABRASAX\UI\abrasax-ui\web\console\console.js"

OLD = '      poll("models", MODELS + "/v1/models", (v) => { state.models = v; }, 6000),'
NEW = '      poll("models", BRIDGE + "/api/models", (v) => { state.models = v; }, 12000),'

OLD2 = '''  function renderModels() {
    const m = state.models;
    const box = $("model-rows");
    if (!m || !(m.data || []).length) {
      box.innerHTML = '<div class="empty">model server offline</div>';
      return;
    }'''
NEW2 = '''  function renderModels() {
    const m = state.models;
    const box = $("model-rows");
    if (!m || !(m.data || []).length) {
      const why = (m && m.error) ? m.error + (m.hint ? " · " + m.hint : "")
        : "model server offline";
      box.innerHTML = '<div class="empty">' + why + "</div>";
      $("model-count").textContent = "0";
      return;
    }'''


def main() -> int:
    src = io.open(P, encoding="utf-8").read()
    changed = 0
    if OLD in src:
        src = src.replace(OLD, NEW, 1)
        changed += 1
    if OLD2 in src:
        src = src.replace(OLD2, NEW2, 1)
        changed += 1
    if not changed:
        print("FAIL: anchors not found")
        return 1
    io.open(P, "w", encoding="utf-8", newline="\n").write(src)
    print(f"console model panel -> bridge proxy ({changed} edits)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
