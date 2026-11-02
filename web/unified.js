/* ABRASAX Unified — mission control client.
 * Vanilla JS, no frameworks, no CDN. Talks to CORE/unified/http_bridge.py.
 *
 * The bridge normally lives at 127.0.0.1:8791, but other local services
 * sometimes hold that port, so the page probes a short, ordered candidate list
 * and remembers the winner (?bridge=8793 overrides, localStorage persists).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const HOST = 'http://127.0.0.1';
  const DEFAULT_PORTS = [8791, 8793, 8794, 8796, 8797, 8798, 8800, 8801];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pad2 = (n) => String(n).padStart(2, '0');

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(v, digits = 0) {
    const n = num(v);
    if (n === null) return '—';
    if (digits === 0) return String(Math.round(n));
    return n.toFixed(digits);
  }

  function gib(mib) {
    const n = num(mib);
    return n === null ? '—' : (n / 1024).toFixed(1) + ' GiB';
  }

  function ageText(seconds) {
    const s = num(seconds);
    if (s === null) return '—';
    if (s < 1) return '<1s';
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  }

  function durationText(seconds) {
    const s = num(seconds);
    if (s === null) return '—';
    if (s < 60) return s.toFixed(1) + 's';
    return ageText(s);
  }

  function clock(d = new Date()) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function pretty(v) {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  function flatten(obj, prefix = '', out = {}) {
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else out[key] = v;
    }
    return out;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setChip(id, tone, text) {
    const el = $(id);
    if (!el) return;
    el.dataset.tone = tone;
    el.textContent = text;
  }

  function setBar(id, pct, tone) {
    const el = $(id);
    if (!el) return;
    const bar = el.querySelector('i');
    if (bar) bar.style.width = `${clamp(num(pct) ?? 0, 0, 100)}%`;
    if (tone) el.dataset.tone = tone;
  }

  function setRing(id, value, max, toneFor) {
    const el = $(id);
    if (!el) return;
    const v = num(value);
    const pct = v === null ? 0 : clamp((v / max) * 100, 0, 100);
    el.style.strokeDashoffset = String(100 - pct);
    const tone = v === null || !toneFor ? null : toneFor(v);
    if (tone) el.dataset.tone = tone;
    else el.removeAttribute('data-tone');
  }

  function toneForPct(v) {
    if (v >= 95) return 'err';
    if (v >= 80) return 'warn';
    return null;
  }

  function toneForTemp(v) {
    if (v >= 85) return 'err';
    if (v >= 72) return 'warn';
    return 'ok';
  }

  // ------------------------------------------------------------------ state
  const params = new URLSearchParams(location.search);
  const queryPort = Number(params.get('bridge'));
  let storedPort = 0;
  try { storedPort = Number(localStorage.getItem('abx.bridgePort')) || 0; } catch (_) { /* private mode */ }

  const candidates = Array.from(new Set(
    [queryPort, storedPort, ...DEFAULT_PORTS]
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
  ));

  const state = {
    port: 0,
    base: '',
    bridgeOnline: false,
    runtimeUp: false,
    health: null,
    telemetry: null,
    telemetryAt: 0,
    jobs: [],
    jobsLoaded: false,
    es: null,
    sseOpen: false,
    lastFrameAt: 0,
    lastSeq: null,
    frameBusy: false,
    frameTimes: [],
    dropped: 0,
    utilHistory: [],
    log: [],
    reconnects: 0,
    jobRunning: false,
    jobsLoading: false,
    discovering: false,
    healthTimer: 0,
  };

  // ------------------------------------------------------------------- wire
  function log(kind, text) {
    state.log.unshift({ t: new Date(), kind, text });
    if (state.log.length > 60) state.log.length = 60;
    renderLog();
  }

  function renderLog() {
    const ol = $('eventLog');
    if (!ol) return;
    if (!state.log.length) {
      ol.innerHTML = '<li><time>--:--:--</time><span>waiting for bridge events…</span></li>';
      return;
    }
    ol.innerHTML = state.log.map((e) => (
      `<li data-kind="${escapeHtml(e.kind)}"><time>${clock(e.t)}</time>` +
      `<span>${escapeHtml(e.text)}</span></li>`
    )).join('');
  }

  function setConn(kind, text, foot) {
    const badge = $('connBadge');
    if (!badge) return;
    badge.dataset.state = kind;
    setText('connText', text);
    setText('footState', foot || (kind === 'up'
      ? 'runtime online'
      : kind === 'down' ? 'link down · retrying' : 'negotiating link…'));
  }

  // -------------------------------------------------------------------- http
  async function req(path, opts = {}) {
    const base = opts.base || state.base;
    if (!base) throw new Error('no bridge');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 3000);
    try {
      const res = await fetch(base + path, {
        method: opts.method || 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
        mode: 'cors',
      });
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        try { data = await res.json(); } catch (_) { data = null; }
      }
      return { ok: res.ok, status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  // --------------------------------------------------------------- discovery
  async function probe(port) {
    try {
      const r = await req('/api/health', { base: `${HOST}:${port}`, timeout: 1400 });
      if (!r.ok || !r.data || typeof r.data !== 'object') return null;
      if (!r.data.bridge || !('runtime' in r.data)) return null;
      return { port, health: r.data };
    } catch (_) {
      return null;
    }
  }

  async function discover() {
    if (state.discovering) return state.bridgeOnline;
    state.discovering = true;
    setConn('wait', 'discovering bridge');
    let hit = null;
    try {
      const results = await Promise.all(candidates.map(probe));
      hit = results.find(Boolean) || null;
    } finally {
      state.discovering = false;
    }
    if (!hit) {
      markBridgeOffline(`no bridge on ${candidates.join(', ')}`);
      return false;
    }
    useBridge(hit.port, hit.health);
    return true;
  }

  function useBridge(port, health) {
    const changed = state.port !== port;
    state.port = port;
    state.base = `${HOST}:${port}`;
    state.bridgeOnline = true;
    if (changed) {
      try { localStorage.setItem('abx.bridgePort', String(port)); } catch (_) { /* ignore */ }
    }
    const addr = $('bridgeAddr');
    if (addr) addr.innerHTML = `bridge <b>:${port}</b>`;
    setText('footBridge', state.base);

    if (changed) {
      log('ok', `bridge discovered at ${state.base}`);
      state.jobsLoaded = false;
      if (state.es) {
        try { state.es.close(); } catch (_) { /* ignore */ }
        state.es = null;
      }
      startStream();
      refreshJobs();
    }
    if (health) applyHealth(health);
  }

  function markBridgeOffline(reason) {
    if (state.bridgeOnline) log('err', `bridge offline — ${reason}`);
    state.bridgeOnline = false;
    state.runtimeUp = false;
    state.health = null;
    state.jobsLoaded = false;
    setConn('down', 'bridge offline');
    setText('bridgeVer', '—');
    setChip('jobStatus', 'err', 'no bridge');
    const hs = $('healthState');
    if (hs) hs.dataset.state = 'down';
    setText('healthText', 'bridge unreachable');
    setText('healthAddr', '—');
    setText('healthError', reason);
    $('runJob').disabled = true;
    stopStream();
    updateStageNote();
    renderPool();
  }

  // ------------------------------------------------------------------ health
  function applyHealth(h) {
    state.health = h;
    state.runtimeUp = !!h.ok;
    const b = h.bridge || {};

    setConn(h.ok ? 'up' : 'down', h.ok ? 'runtime up' : 'runtime down',
      h.ok ? 'runtime online' : 'runtime down · bridge online');
    setText('bridgeVer', b.version || '—');
    if (num(b.uptime_s) !== null) setText('reconnectCount', String(state.reconnects));
    const addr = $('bridgeAddr');
    if (addr) addr.innerHTML = `bridge <b>:${state.port}</b>`;

    const hs = $('healthState');
    if (hs) hs.dataset.state = h.ok ? 'up' : 'down';
    setText('healthText', h.ok ? 'runtime up' : 'runtime down');
    setText('healthAddr', b.runtime_addr || '—');
    setText('footRuntime', b.runtime_addr || '—');
    setText('healthVersion', h.runtime_version || '—');
    setText('healthProtocol', num(h.protocol) === null ? '—' : `v${h.protocol} · ABXU`);
    setText('healthCaps', Array.isArray(h.caps) ? h.caps.join(' · ') : '—');
    setText('healthUptime', h.ok ? durationText(h.connected_s) : '—');
    setText('healthTeleAge', num(h.telemetry_age_s) === null ? '—' : ageText(h.telemetry_age_s));
    const frame = h.frame || {};
    setText('healthFrameAge', num(frame.age_s) === null ? '—' : ageText(frame.age_s));
    setText('healthError', h.last_error || '—');

    if (h.ok) {
      if (!state.es) startStream();
      if (!state.jobsLoaded) refreshJobs();
    } else if (state.es) {
      // Keep the SSE socket: the bridge is alive and will stream again once the
      // runtime returns. The iframe note explains the state.
    }
    updateStageNote();
    updateRunEnabled();
    renderPool();
  }

  async function pollHealth() {
    clearTimeout(state.healthTimer);
    if (!state.base) {
      await discover();
    } else {
      try {
        const r = await req('/api/health', { timeout: 2200 });
        if (r.data && r.data.bridge) {
          if (!state.bridgeOnline) {
            state.reconnects += 1;
            log('ok', 'bridge back online');
          }
          useBridge(state.port, r.data);
        } else {
          markBridgeOffline('bad /api/health payload');
        }
      } catch (err) {
        markBridgeOffline(err && err.name === 'AbortError' ? 'health timeout' : 'health unreachable');
        await discover();
      }
    }
    state.healthTimer = setTimeout(pollHealth, state.bridgeOnline ? 2000 : 2000);
  }

  // --------------------------------------------------------------- telemetry
  async function pollTelemetry() {
    if (state.bridgeOnline) {
      try {
        const r = await req('/api/telemetry', { timeout: 2200 });
        if (r.data && typeof r.data === 'object') applyTelemetry(r.data);
      } catch (_) {
        /* health polling owns the offline transition */
      }
    }
    setTimeout(pollTelemetry, 1000);
  }

  function applyTelemetry(t) {
    state.telemetry = t;
    state.telemetryAt = performance.now();
    setText('teleStamp', clock());

    const gpu = (t.gpu && typeof t.gpu === 'object') ? t.gpu : {};
    const cpu = (t.cpu && typeof t.cpu === 'object') ? t.cpu : {};

    // ---- GPU identity
    setText('gpuName', gpu.name || (gpu.available ? 'GPU' : 'GPU unavailable'));
    setText('gpuSource', gpu.source || (gpu.available ? 'nvml' : 'offline'));

    // ---- utilization ring
    const util = num(gpu.util_pct);
    setRing('utilRing', util, 100, toneForPct);
    setText('utilVal', util === null ? '—' : fmt(util));
    setText('utilSub', util === null ? 'n/a' : 'gpu');
    setText('memUtil', gpu.mem_util_pct === undefined || gpu.mem_util_pct === null
      ? '—' : `${fmt(gpu.mem_util_pct)}%`);

    if (util !== null) {
      state.utilHistory.push(clamp(util, 0, 100));
      if (state.utilHistory.length > 60) state.utilHistory.shift();
      drawSpark();
      setText('utilSparkVal', `${fmt(util)}%`);
    }

    // ---- temperature ring
    const temp = num(gpu.temp_c);
    setRing('tempRing', temp, 100, toneForTemp);
    setText('tempVal', temp === null ? '—' : fmt(temp));
    setText('tempSub', temp === null ? 'n/a' : (temp >= 85 ? 'hot' : temp >= 72 ? 'warm' : 'nominal'));
    const clocks = gpu.clocks || {};
    const sm = num(clocks.sm);
    const mem = num(clocks.mem);
    setText('clocksVal', (sm === null && mem === null)
      ? '—'
      : `${sm === null ? '—' : fmt(sm)} / ${mem === null ? '—' : fmt(mem)} MHz`);

    // ---- vram
    const used = num(gpu.mem_used_mib);
    const total = num(gpu.mem_total_mib);
    const free = num(gpu.mem_free_mib);
    const memPct = (used !== null && total) ? (used / total) * 100
      : num(gpu.mem_util_pct);
    const vramBig = $('vramBig');
    if (vramBig) {
      vramBig.innerHTML = used === null || total === null
        ? '—'
        : `${escapeHtml(fmt(used))} <small>/ ${escapeHtml(fmt(total))} MiB</small>`;
    }
    setBar('vramBar', memPct, memPct !== null && memPct >= 95 ? 'err' : memPct >= 85 ? 'warn' : 'ok');
    setText('vramPct', memPct === null ? '—' : `${fmt(memPct)}%`);
    setText('vramFree', free === null ? '—' : `${fmt(free)} MiB`);
    setText('vramSub', total ? `${fmt(total)} MiB total` : 'n/a');

    // ---- power
    const power = num(gpu.power_w);
    const powerBig = $('powerBig');
    if (powerBig) {
      powerBig.innerHTML = power === null
        ? '—'
        : `${escapeHtml(fmt(power))} <small>W</small>`;
    }
    setBar('powerBar', power === null ? 0 : (power / 250) * 100,
      power !== null && power >= 200 ? 'warn' : 'ok');
    setText('powerSrc', gpu.source || '—');
    setText('powerBudget', power === null ? '—' : 'scale 250 W');

    // ---- cpu block
    const cpuPct = num(cpu.cpu_pct);
    const cpuPctEl = $('cpuPct');
    if (cpuPctEl) {
      cpuPctEl.innerHTML = `${escapeHtml(cpuPct === null ? '—' : fmt(cpuPct))}<small>%</small>`;
    }
    setBar('cpuBar', cpuPct, cpuPct !== null && cpuPct >= 90 ? 'warn' : 'ok');
    setText('cpuStamp', cpu.available === false ? 'psutil off' : clock());
    setText('coresLogical', cpu.cores_logical ?? '—');
    setText('coresPhysical', cpu.cores_physical ?? '—');
    setText('cpuSub', cpu.cores_logical
      ? `${cpu.cores_logical} logical threads`
      : 'cores —');

    const load = Array.isArray(cpu.load) ? cpu.load : null;
    setText('cpuLoad', load && load.length
      ? load.slice(0, 3).map((x) => fmt(x, 2)).join(' / ')
      : '—');
    setText('cpuFreq', num(cpu.freq_mhz) === null
      ? '—'
      : `${fmt(cpu.freq_mhz)} MHz`);

    const ram = cpu.ram || {};
    const ramUsed = num(ram.used_mib);
    const ramTotal = num(ram.total_mib);
    const ramPct = num(ram.percent) ?? (ramUsed !== null && ramTotal ? (ramUsed / ramTotal) * 100 : null);
    setText('ramUsed', ramUsed === null || ramTotal === null
      ? '—'
      : `${gib(ramUsed)} / ${gib(ramTotal)}`);
    setText('ramFree', num(ram.available_mib) === null ? '—' : gib(ram.available_mib));
    setBar('ramBar', ramPct, ramPct !== null && ramPct >= 90 ? 'err' : ramPct >= 78 ? 'warn' : 'ok');

    renderCores(cpu.per_core);
    renderPool();
  }

  function renderCores(perCore) {
    const grid = $('coreGrid');
    if (!grid) return;
    if (!Array.isArray(perCore) || !perCore.length) {
      if (grid.childElementCount) grid.innerHTML = '';
      return;
    }
    const n = perCore.length;
    if (grid.childElementCount !== n) {
      grid.innerHTML = '';
      for (let i = 0; i < n; i += 1) grid.appendChild(document.createElement('i'));
    }
    const kids = grid.children;
    for (let i = 0; i < n; i += 1) {
      const v = clamp(num(perCore[i]) ?? 0, 0, 100);
      kids[i].style.height = `${2 + (v / 100) * 28}px`;
      kids[i].dataset.tone = v >= 90 ? 'max' : v >= 65 ? 'hot' : 'cool';
    }
  }

  function renderPool() {
    const wrap = $('poolStats');
    if (!wrap) return;
    const chips = [];
    let runtimeKeys = 0;
    const flat = flatten(state.telemetry || {});
    for (const [k, v] of Object.entries(flat)) {
      if (chips.length >= 8) break;
      if (typeof v !== 'number') continue;
      if (!/pool|worker|pending|queue|submitted|completed|failed|running|busy|thread/i.test(k)) continue;
      const short = k.includes('.') ? k.split('.').slice(-2).join('.') : k;
      chips.push([short, fmt(v)]);
      runtimeKeys += 1;
    }
    const b = (state.health && state.health.bridge) || {};
    const frame = (state.health && state.health.frame) || {};
    chips.push(['bridge jobs', fmt(b.jobs_run ?? 0)]);
    chips.push(['avg job', num(b.avg_job_ms) === null ? '—' : `${fmt(b.avg_job_ms, 2)} ms`]);
    chips.push(['frames', frame.frames == null ? '0' : fmt(frame.frames)]);
    wrap.innerHTML = chips.map(([k, v]) => (
      `<span>${escapeHtml(k)} <b>${escapeHtml(String(v))}</b></span>`
    )).join('');
    setText('poolNote', runtimeKeys
      ? 'Pool counters published by the runtime telemetry payload, plus live bridge counters.'
      : 'Runtime is not publishing pool counters yet; bridge job/frame counters are live.');
  }

  // ------------------------------------------------------------------- spark
  function drawSpark() {
    const c = $('utilSpark');
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(124, 108, 240, .14)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const y = (H / 4) * i + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    const data = state.utilHistory;
    if (data.length < 2) {
      ctx.fillStyle = 'rgba(125, 125, 148, .9)';
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.fillText('collecting samples…', 8, 15);
      return;
    }
    const step = W / 59;
    const x = (i) => i * step;
    const y = (v) => H - 4 - (v / 100) * (H - 8);
    const start = W - (data.length - 1) * step;

    ctx.beginPath();
    data.forEach((v, i) => {
      const px = start + x(i);
      const py = y(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#7c6cf0';
    ctx.stroke();

    ctx.lineTo(start + x(data.length - 1), H);
    ctx.lineTo(start, H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(124, 108, 240, .34)');
    grad.addColorStop(1, 'rgba(124, 108, 240, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ------------------------------------------------------------------ frames
  function startStream() {
    if (state.es || !state.base) return;
    let es;
    try {
      es = new EventSource(`${state.base}/api/stream`);
    } catch (_) {
      log('err', 'EventSource unavailable');
      return;
    }
    state.es = es;
    es.onopen = () => {
      state.sseOpen = true;
      log('ok', 'SSE frame stream open');
    };
    es.onmessage = (ev) => {
      let d = null;
      try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (!d || !d.png) return;
      paintFrame(`data:image/png;base64,${d.png}`, d.seq);
    };
    es.onerror = () => {
      state.sseOpen = false;
      if (es.readyState === 2 /* CLOSED */ || es.readyState === 0) {
        state.es = null;
        try { es.close(); } catch (_) { /* ignore */ }
        setTimeout(() => {
          if (state.bridgeOnline) {
            state.reconnects += 1;
            log('warn', 'SSE reconnecting');
            startStream();
          }
        }, 1500);
      }
    };
  }

  function stopStream() {
    if (state.es) {
      try { state.es.close(); } catch (_) { /* ignore */ }
      state.es = null;
    }
    state.sseOpen = false;
  }

  function paintFrame(src, seq) {
    if (state.frameBusy) {
      state.dropped += 1;
      return;
    }
    state.frameBusy = true;
    const img = new Image();
    img.onload = () => {
      state.frameBusy = false;
      const c = $('frameCanvas');
      if (!c) return;
      if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
      }
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      c.classList.add('ready');
      const now = performance.now();
      state.lastFrameAt = now;
      if (seq !== undefined && seq !== null) state.lastSeq = seq;
      state.frameTimes.push(now);
      updateFrameStats();
      updateStageNote();
    };
    img.onerror = () => { state.frameBusy = false; };
    img.src = src;
  }

  function updateFrameStats() {
    const now = performance.now();
    const cutoff = now - 1000;
    while (state.frameTimes.length && state.frameTimes[0] < cutoff) state.frameTimes.shift();
    const fps = state.frameTimes.length;
    const canvas = $('frameCanvas');
    const res = canvas ? `${canvas.width}×${canvas.height}` : '—';
    setText('frameFps', fps.toFixed(1));
    setText('frameFpsFoot', fps.toFixed(1));
    setText('frameSeq', state.lastSeq === null ? '—' : String(state.lastSeq));
    setText('frameSeqFoot', state.lastSeq === null ? '—' : String(state.lastSeq));
    setText('frameRes', res);
  }

  function updateStageNote() {
    const note = $('frameNote');
    const title = $('frameNoteTitle');
    const sub = $('frameNoteSub');
    if (!note) return;
    const fresh = state.lastFrameAt && (performance.now() - state.lastFrameAt) < 4000;
    const stage = note.parentElement;
    if (stage) stage.classList.toggle('stale', !fresh);
    if (fresh) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    const addr = (state.health && state.health.bridge && state.health.bridge.runtime_addr) || '';
    const port = addr.includes(':') ? addr.split(':').pop() : '8790';
    if (!state.bridgeOnline) {
      if (title) title.textContent = 'bridge offline';
      if (sub) sub.textContent = `start CORE\\unified\\http_bridge.py --port ${state.port || 8791}`;
    } else if (!state.runtimeUp) {
      if (title) title.textContent = 'runtime down';
      if (sub) sub.textContent = `start: cd CORE && python -m unified serve --port ${port}`;
    } else {
      if (title) title.textContent = 'waiting for frames';
      if (sub) sub.textContent = 'subscribed at 10 fps · retrying';
    }
  }

  // last-resort frame feed if EventSource cannot stream through a proxy/browser
  async function frameFallbackTick() {
    const stale = performance.now() - (state.lastFrameAt || 0) > 3000;
    if (state.bridgeOnline && state.runtimeUp && stale && !state.frameBusy) {
      const url = `${state.base}/api/frame.png?w=320&_=${Date.now()}`;
      try {
        state.frameBusy = true;
        const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
        if (res.ok) {
          const blob = await res.blob();
          const obj = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            state.frameBusy = false;
            paintFrameFromImage(img);
            URL.revokeObjectURL(obj);
          };
          img.onerror = () => {
            state.frameBusy = false;
            URL.revokeObjectURL(obj);
          };
          img.src = obj;
        } else {
          state.frameBusy = false;
        }
      } catch (_) {
        state.frameBusy = false;
      }
    }
    setTimeout(frameFallbackTick, 250);
  }

  function paintFrameFromImage(img) {
    const c = $('frameCanvas');
    if (!c) return;
    if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) {
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
    }
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    c.classList.add('ready');
    const now = performance.now();
    state.lastFrameAt = now;
    state.frameTimes.push(now);
    updateFrameStats();
    updateStageNote();
  }

  // -------------------------------------------------------------- job console
  async function refreshJobs() {
    if (!state.bridgeOnline || state.jobsLoading) return;
    state.jobsLoading = true;
    try {
      const r = await req('/api/jobs', { timeout: 2500 });
      if (r.ok && Array.isArray(r.data)) {
        state.jobs = r.data;
        state.jobsLoaded = true;
        renderJobSelect();
        if (state.jobs.length) log('ok', `runtime advertises ${state.jobs.length} job${state.jobs.length === 1 ? '' : 's'}`);
        else log('warn', 'runtime advertises 0 jobs (math_core not loaded?)');
      } else if (r.status === 503) {
        state.jobs = [];
        state.jobsLoaded = false;
        renderJobSelect('runtime down');
      } else {
        state.jobs = [];
        state.jobsLoaded = false;
        renderJobSelect('job list unavailable');
      }
    } catch (_) {
      state.jobsLoaded = false;
      renderJobSelect('job list unavailable');
    } finally {
      state.jobsLoading = false;
    }
    updateRunEnabled();
  }

  function renderJobSelect(emptyLabel) {
    const sel = $('jobSelect');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    const jobs = state.jobs;

    if (jobs.length) {
      for (const j of jobs) {
        const opt = document.createElement('option');
        opt.value = j;
        opt.textContent = j;
        sel.appendChild(opt);
      }
      const custom = document.createElement('option');
      custom.value = '__custom';
      custom.textContent = 'custom…';
      sel.appendChild(custom);
      if (jobs.includes(prev)) sel.value = prev;
      $('customJobField').hidden = sel.value !== '__custom';
      setText('jobHint', 'names from HELLO_ACK');
      $('jobHint').classList.remove('warn');
      setText('jobCount', `${jobs.length} job${jobs.length === 1 ? '' : 's'}`);
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = emptyLabel || 'no jobs advertised';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
      $('customJobField').hidden = false;
      setText('jobHint', 'runtime advertised 0 jobs — type a kernel name');
      $('jobHint').classList.add('warn');
      setText('jobCount', '0 jobs');
    }
    updateRunEnabled();
  }

  function currentJob() {
    const sel = $('jobSelect');
    const value = sel ? sel.value : '';
    if (!state.jobs.length || value === '__custom') {
      return $('customJob') ? $('customJob').value.trim() : '';
    }
    return value.trim();
  }

  function updateRunEnabled() {
    const btn = $('runJob');
    if (!btn) return;
    btn.disabled = state.jobRunning || !state.runtimeUp || !currentJob();
  }

  function setResult(text, kind, meta) {
    const pre = $('jobResult');
    if (!pre) return;
    pre.textContent = text;
    pre.classList.toggle('empty', kind === 'empty');
    setText('resultMeta', meta || (kind === 'error' ? 'error' : 'JOB_RESULT'));
  }

  async function runJob() {
    if (state.jobRunning) return;
    const job = currentJob();
    if (!job) {
      setChip('jobStatus', 'warn', 'pick a job');
      return;
    }
    let args;
    try {
      args = JSON.parse(($('jobArgs').value || '{}'));
    } catch (err) {
      setChip('jobStatus', 'err', 'bad json');
      setResult(`Arguments are not valid JSON:\n${err.message}`, 'error');
      log('err', 'job args are not valid JSON');
      return;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      setChip('jobStatus', 'err', 'bad args');
      setResult('Arguments must be a JSON object, e.g. { "a": 0.2, "b": 0.3 }', 'error');
      return;
    }

    state.jobRunning = true;
    updateRunEnabled();
    setChip('jobStatus', 'busy', 'running…');
    setText('jobLatency', '— ms');
    setResult(`POST /api/job\n${pretty({ job, args })}`, 'empty', 'waiting for JOB_RESULT');

    const started = performance.now();
    try {
      const r = await req('/api/job', { method: 'POST', body: { job, args }, timeout: 35000 });
      const wall = performance.now() - started;
      const data = r.data || {};

      if (r.status === 503) {
        setChip('jobStatus', 'err', 'runtime down');
        setResult(`Runtime is down.\n\n${pretty(data)}`, 'error');
        log('err', `${job}: runtime down`);
      } else if (!r.data) {
        setChip('jobStatus', 'err', `http ${r.status}`);
        setResult(`Bridge returned HTTP ${r.status} with no JSON body.`, 'error');
        log('err', `${job}: HTTP ${r.status}`);
      } else if (data.ok) {
        const jobMs = num(data.ms);
        const bridgeMs = num(data.bridge_ms);
        setChip('jobStatus', 'ok', 'ok');
        setText('jobLatency', `${fmt(wall, 1)} ms`);
        setResult(pretty(data.result), 'ok',
          `job ${jobMs === null ? '—' : fmt(jobMs, 2)} ms · bridge ${bridgeMs === null ? '—' : fmt(bridgeMs, 2)} ms`);
        log('ok', `${job} → ok in ${jobMs === null ? fmt(wall, 1) : fmt(jobMs, 2)} ms`);
      } else {
        setChip('jobStatus', 'err', 'failed');
        setText('jobLatency', `${fmt(wall, 1)} ms`);
        setResult(pretty(data), 'error');
        log('err', `${job} → ${data.error || 'job failed'}`);
      }
    } catch (err) {
      const wall = performance.now() - started;
      setChip('jobStatus', 'err', 'no bridge');
      setText('jobLatency', `${fmt(wall, 1)} ms`);
      setResult(`Bridge unreachable: ${err && err.message ? err.message : err}`, 'error');
      log('err', `${job}: bridge unreachable`);
      markBridgeOffline('job request failed');
    } finally {
      state.jobRunning = false;
      updateRunEnabled();
    }
  }

  // -------------------------------------------------------------------- loops
  function ageTick() {
    const now = performance.now();
    if (state.telemetryAt) {
      const age = (now - state.telemetryAt) / 1000;
      setText('gpuAge', `age ${age < 1 ? '<1' : Math.round(age)}s`);
      if (age > 4) setText('teleStamp', 'stale');
    } else {
      setText('gpuAge', 'age —');
    }
    if (state.lastFrameAt) {
      const age = (now - state.lastFrameAt) / 1000;
      setText('frameAge', age < 1 ? '<1s' : `${Math.round(age)}s`);
      updateFrameStats();
    } else {
      setText('frameAge', '—');
      setText('frameFps', '0.0');
      setText('frameFpsFoot', '0.0');
    }
    if (state.health) {
      const hs = state.health;
      if (hs.frame && num(hs.frame.age_s) !== null && !state.lastFrameAt) {
        setText('healthFrameAge', ageText(hs.frame.age_s));
      }
    }
    if (state.lastFrameAt) {
      const c = $('frameCanvas');
      if (c && c.width) setText('frameRes', `${c.width}×${c.height}`);
    }
  }

  // --------------------------------------------------------------------- boot
  function wire() {
    const retry = $('retryBtn');
    if (retry) retry.addEventListener('click', async () => {
      log('warn', 'manual reconnect requested');
      state.base = '';
      state.port = 0;
      stopStream();
      await discover();
    });

    const refresh = $('refreshJobs');
    if (refresh) refresh.addEventListener('click', () => {
      state.jobsLoaded = false;
      refreshJobs();
    });

    const run = $('runJob');
    if (run) run.addEventListener('click', runJob);

    const format = $('formatArgs');
    if (format) format.addEventListener('click', () => {
      const ta = $('jobArgs');
      try {
        ta.value = JSON.stringify(JSON.parse(ta.value || '{}'), null, 2);
        setChip('jobStatus', 'idle', 'formatted');
      } catch (err) {
        setChip('jobStatus', 'err', 'bad json');
        setResult(`Cannot format: ${err.message}`, 'error');
      }
    });

    const sel = $('jobSelect');
    if (sel) sel.addEventListener('change', () => {
      const custom = $('customJobField');
      const isCustom = sel.value === '__custom';
      if (custom) custom.hidden = !isCustom;
      if (isCustom && $('customJob')) $('customJob').focus();
      updateRunEnabled();
    });

    const customJob = $('customJob');
    if (customJob) customJob.addEventListener('input', updateRunEnabled);

    const args = $('jobArgs');
    if (args) args.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        runJob();
      }
    });
  }

  function boot() {
    wire();
    renderLog();
    drawSpark();
    renderJobSelect('connecting…');
    setConn('wait', 'discovering bridge');
    log('warn', `bridge candidates: ${candidates.join(', ')}`);
    pollHealth();
    pollTelemetry();
    setInterval(ageTick, 500);
    setTimeout(frameFallbackTick, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
