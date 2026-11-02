/* ABRASAX S25 sensor bridge — zero build, no dependencies.
 *
 * Contract (shared with SCRIPTS/sensors/s25_termux_forward.py):
 *   POST /v1/sensors/ingest  {mag:[3], imu:[6], env:[2], rf_fingerprint, timestamp, learn}
 *   POST /v1/sensors/batch   {samples:[...]}              max 256
 *   GET  /v1/sensors/state
 *   Authorization: Bearer <token>                        when configured
 *
 * Units, fixed by contract:
 *   mag  [mx,my,mz]                 microtesla
 *   imu  [ax,ay,az, gx,gy,gz]       m/s^2 (gravity included), rad/s
 *   env  [temperature_c, pressure_hpa]
 *
 * Persistence is session-scoped only: the token lives in sessionStorage and
 * is never written into a log line, a URL, or non-input DOM text.
 */
(function () {
  "use strict";

  var SAMPLE_HZ_DEFAULT = 10;
  var BATCH_SIZE_DEFAULT = 20;
  var MAX_BATCH = 256;
  var MAX_QUEUE = 512;
  var STATE_POLL_MS = 2000;
  var REQUEST_TIMEOUT_MS = 8000;
  var MAX_LOG_LINES = 200;

  var PATHS = {
    ingest: "/v1/sensors/ingest",
    batch: "/v1/sensors/batch",
    state: "/v1/sensors/state"
  };

  var STORE = {
    baseUrl: "abrasax.sensors.baseUrl",
    token: "abrasax.sensors.token",
    hz: "abrasax.sensors.hz",
    batch: "abrasax.sensors.batch",
    learn: "abrasax.sensors.learn"
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    baseUrl: $("baseUrl"),
    token: $("token"),
    connectBtn: $("connectBtn"),
    disconnectBtn: $("disconnectBtn"),
    refreshStateBtn: $("refreshStateBtn"),
    permissionBtn: $("permissionBtn"),
    magnetometerBtn: $("magnetometerBtn"),
    startBtn: $("startBtn"),
    stopBtn: $("stopBtn"),
    sendOnceBtn: $("sendOnceBtn"),
    simulateBtn: $("simulateBtn"),
    stopSimBtn: $("stopSimBtn"),
    sampleHz: $("sampleHz"),
    batchSize: $("batchSize"),
    learnToggle: $("learnToggle"),
    modeBadge: $("modeBadge"),
    connectionDot: $("connectionDot"),
    connectionState: $("connectionState"),
    permissionStatus: $("permissionStatus"),
    sensorAvailability: $("sensorAvailability"),
    samplesSent: $("samplesSent"),
    batchesSent: $("batchesSent"),
    queueDepth: $("queueDepth"),
    droppedCount: $("droppedCount"),
    batteryStatus: $("batteryStatus"),
    networkStatus: $("networkStatus"),
    lastHttp: $("lastHttp"),
    lastError: $("lastError"),
    liveAccel: $("liveAccel"),
    liveGyro: $("liveGyro"),
    liveMag: $("liveMag"),
    liveEnv: $("liveEnv"),
    lastEntropy: $("lastEntropy"),
    lastPoincare: $("lastPoincare"),
    lastResponse: $("lastResponse"),
    eventLog: $("eventLog"),
    clearLogBtn: $("clearLogBtn"),
    insecureBanner: $("insecureBanner")
  };

  var state = {
    connected: false,
    streaming: false,
    simulating: false,
    inFlight: false,
    sent: 0,
    batches: 0,
    dropped: 0,
    queue: [],
    sampleTimer: null,
    pollTimer: null,
    flushTimer: null,
    retryDelay: 500,
    startedAt: 0,
    warnedNoData: false,
    warnedOffline: false,
    latest: {
      accel: null,
      gyro: null,
      mag: null,
      magAt: 0,
      temp: null,
      pressure: null,
      at: 0
    },
    sensors: {
      motion: false,
      orientation: false,
      magnetometer: false,
      pressure: false,
      battery: false,
      network: false
    },
    permission: "not requested",
    magSensor: null,
    pressureSensor: null
  };

  // ------------------------------------------------------------------ utils

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function round6(value) {
    return Math.round(num(value) * 1e6) / 1e6;
  }

  function clampInt(value, low, high, fallback) {
    if (value === "" || value === null || value === undefined) { return fallback; }
    var n = Math.round(Number(value));
    if (!Number.isFinite(n)) { return fallback; }
    return Math.min(high, Math.max(low, n));
  }

  function readHz() {
    return clampInt(els.sampleHz.value, 1, 60, SAMPLE_HZ_DEFAULT);
  }

  function readBatch() {
    return clampInt(els.batchSize.value, 1, MAX_BATCH, BATCH_SIZE_DEFAULT);
  }

  function samplePeriodMs() {
    return 1000 / readHz();
  }

  function redact(text) {
    var token = (els.token.value || "").trim();
    var out = String(text);
    return token ? out.split(token).join("[redacted]") : out;
  }

  function log(message, level) {
    var line = document.createElement("li");
    line.className = "log-" + (level || "info");
    var stamp = document.createElement("span");
    stamp.className = "log-time";
    stamp.textContent = new Date().toLocaleTimeString();
    var body = document.createElement("span");
    body.className = "log-msg";
    body.textContent = redact(message);
    line.appendChild(stamp);
    line.appendChild(body);
    els.eventLog.appendChild(line);
    while (els.eventLog.children.length > MAX_LOG_LINES) {
      els.eventLog.removeChild(els.eventLog.firstChild);
    }
    els.eventLog.scrollTop = els.eventLog.scrollHeight;
  }

  function setError(message) {
    els.lastError.textContent = message ? redact(message) : "—";
    els.lastError.title = message ? redact(message) : "";
  }

  // -------------------------------------------------------------- persistence

  function loadConfig() {
    try {
      var store = window.sessionStorage;
      var base = store.getItem(STORE.baseUrl);
      var token = store.getItem(STORE.token);
      var hz = store.getItem(STORE.hz);
      var batch = store.getItem(STORE.batch);
      var learn = store.getItem(STORE.learn);
      if (base) { els.baseUrl.value = base; }
      if (token) { els.token.value = token; }
      if (hz) { els.sampleHz.value = clampInt(hz, 1, 60, SAMPLE_HZ_DEFAULT); }
      if (batch) { els.batchSize.value = clampInt(batch, 1, MAX_BATCH, BATCH_SIZE_DEFAULT); }
      if (learn === "1") { els.learnToggle.checked = true; }
    } catch (err) {
      log("sessionStorage unavailable; settings will not persist", "warn");
    }
  }

  function saveConfig() {
    try {
      var store = window.sessionStorage;
      store.setItem(STORE.baseUrl, els.baseUrl.value.trim());
      store.setItem(STORE.token, els.token.value.trim());
      store.setItem(STORE.hz, String(readHz()));
      store.setItem(STORE.batch, String(readBatch()));
      store.setItem(STORE.learn, els.learnToggle.checked ? "1" : "0");
    } catch (err) {
      /* private mode: stay in memory only */
    }
  }

  // ------------------------------------------------------------------ HTTP

  function normalizedBase() {
    var raw = (els.baseUrl.value || "").trim().replace(/\/+$/, "");
    if (!raw) { throw new Error("base URL is empty"); }
    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      throw new Error("base URL must be absolute, e.g. http://192.168.1.20:9001");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("base URL must use http:// or https://");
    }
    if (url.username || url.password) {
      throw new Error("do not put credentials in the base URL; use the token field");
    }
    var path = url.pathname.replace(/\/+$/, "");
    return url.origin + path;
  }

  function setConnection(mode) {
    var labels = {
      idle: "not connected",
      connecting: "connecting…",
      online: "connected",
      offline: "offline",
      unauthorized: "401 unauthorized",
      "insecure": "blocked by browser"
    };
    els.connectionDot.setAttribute("data-state", mode);
    els.connectionState.textContent = labels[mode] || mode;
    state.connected = mode === "online";
    renderControls();
    renderMode();
  }

  function api(path, options) {
    options = options || {};
    var base;
    try {
      base = normalizedBase();
    } catch (err) {
      return Promise.reject(err);
    }
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    var headers = { "Accept": "application/json" };
    var token = (els.token.value || "").trim();
    if (token) {
      // The only place the token is ever put on the wire.
      headers["Authorization"] = "Bearer " + token;
    }
    var init = {
      method: options.method || "GET",
      headers: headers,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal: controller.signal
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch(base + path, init).then(function (response) {
      els.lastHttp.textContent = String(response.status) + " " + (options.method || "GET") + " " + path;
      return response.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (err) { data = { raw: text.slice(0, 2000) }; }
        }
        if (!response.ok) {
          var message = "HTTP " + response.status;
          if (data && data.error) {
            if (typeof data.error === "string") { message = data.error; }
            else if (data.error.message) { message = data.error.message; }
          } else if (response.statusText) {
            message = "HTTP " + response.status + " " + response.statusText;
          }
          var failure = new Error(message);
          failure.status = response.status;
          failure.data = data;
          throw failure;
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.name === "AbortError") {
        var timeout = new Error("request timed out after " + REQUEST_TIMEOUT_MS + " ms");
        timeout.status = 0;
        throw timeout;
      }
      throw err;
    }).finally(function () {
      window.clearTimeout(timer);
    });
  }

  // --------------------------------------------------------------- payloads

  function motionVector(event) {
    var accel = event.accelerationIncludingGravity || event.acceleration;
    if (!accel) { return null; }
    return [num(accel.x), num(accel.y), num(accel.z)];
  }

  function gyroVector(event) {
    var rate = event.rotationRate;
    if (!rate) { return [0, 0, 0]; }
    var d2r = Math.PI / 180;
    return [num(rate.alpha) * d2r, num(rate.beta) * d2r, num(rate.gamma) * d2r];
  }

  /* Approximate magnetic vector in the device frame from alpha/beta/gamma.
   * Used only when the Magnetometer API is absent. It assumes a horizontal
   * world field of 45 uT pointing north; it is a direction indicator, not a
   * calibrated measurement. Marked as such in the availability panel. */
  function magnetometerFromOrientation(alpha, beta, gamma) {
    if (typeof alpha !== "number" || typeof beta !== "number" || typeof gamma !== "number") {
      return null;
    }
    var a = alpha * Math.PI / 180;
    var b = beta * Math.PI / 180;
    var g = gamma * Math.PI / 180;
    var ca = Math.cos(a), sa = Math.sin(a);
    var cb = Math.cos(b), sb = Math.sin(b);
    var cg = Math.cos(g), sg = Math.sin(g);
    var scale = 45;
    return [
      scale * (sa * cg + ca * sb * sg),
      scale * (ca * cb),
      scale * (sa * sg - ca * sb * cg)
    ];
  }

  function onMotion(event) {
    var accel = motionVector(event);
    if (!accel) { return; }
    state.latest.accel = accel;
    state.latest.gyro = gyroVector(event);
    state.latest.at = performance.now();
    if (!state.sensors.motion) {
      state.sensors.motion = true;
      renderAvailability();
    }
  }

  function onOrientation(event) {
    if (event.alpha === null && event.beta === null && event.gamma === null) { return; }
    if (!state.sensors.orientation) {
      state.sensors.orientation = true;
      renderAvailability();
    }
    if (!state.sensors.magnetometer) {
      var mag = magnetometerFromOrientation(event.alpha, event.beta, event.gamma);
      if (mag) {
        state.latest.mag = mag;
        state.latest.magAt = performance.now();
        renderLive();
      }
    }
  }

  function simulatedSample(now) {
    var t = state.startedAt ? (now - state.startedAt) / 1000 : 0;
    var w = 2 * Math.PI * 0.4;
    return {
      mag: [
        round6(18 + 6 * Math.sin(t * 0.7)),
        round6(-4 + 3 * Math.cos(t * 0.5)),
        round6(42 + 5 * Math.sin(t * 0.3))
      ],
      imu: [
        round6(0.35 * Math.sin(t * w)),
        round6(0.28 * Math.cos(t * w * 0.8)),
        round6(9.81 + 0.12 * Math.sin(t * w * 1.6)),
        round6(0.05 * Math.sin(t * 0.9)),
        round6(0.04 * Math.cos(t * 1.1)),
        round6(0.03 * Math.sin(t * 0.6))
      ],
      env: [
        round6(23.5 + 0.2 * Math.sin(t * 0.05)),
        round6(1013.2 + 0.4 * Math.sin(t * 0.02))
      ],
      rf_fingerprint: "sim-web",
      timestamp: new Date(now).toISOString(),
      learn: !!els.learnToggle.checked
    };
  }

  function buildSample() {
    var now = Date.now();
    if (state.simulating) { return simulatedSample(now); }

    var fresh = state.latest.at && (performance.now() - state.latest.at) < Math.max(1500, samplePeriodMs() * 3);
    if (!fresh) { return null; }

    var accel = state.latest.accel || [0, 0, 0];
    var gyro = state.latest.gyro || [0, 0, 0];
    var mag = state.latest.mag || [0, 0, 0];
    return {
      mag: [round6(mag[0]), round6(mag[1]), round6(mag[2])],
      imu: [
        round6(accel[0]), round6(accel[1]), round6(accel[2]),
        round6(gyro[0]), round6(gyro[1]), round6(gyro[2])
      ],
      env: [
        round6(state.latest.temp === null ? 0 : state.latest.temp),
        round6(state.latest.pressure === null ? 0 : state.latest.pressure)
      ],
      rf_fingerprint: "web-s25",
      timestamp: new Date(now).toISOString(),
      learn: !!els.learnToggle.checked
    };
  }

  function validSample(sample) {
    if (!sample || typeof sample !== "object") { return false; }
    var shapes = { mag: 3, imu: 6, env: 2 };
    var keys = Object.keys(shapes);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var values = sample[key];
      if (!Array.isArray(values) || values.length !== shapes[key]) { return false; }
      for (var j = 0; j < values.length; j += 1) {
        if (!Number.isFinite(values[j])) { return false; }
      }
    }
    return true;
  }

  // ------------------------------------------------------------- telemetry

  function findEntry(root, aliases, depth) {
    depth = depth || 0;
    if (!root || typeof root !== "object" || depth > 7) { return null; }
    if (Array.isArray(root)) {
      for (var i = 0; i < root.length; i += 1) {
        var found = findEntry(root[i], aliases, depth + 1);
        if (found) { return found; }
      }
      return null;
    }
    var entries = Object.entries(root);
    for (var e = 0; e < entries.length; e += 1) {
      var key = entries[e][0].toLowerCase();
      if (aliases.indexOf(key) !== -1) {
        return { key: entries[e][0], value: entries[e][1] };
      }
    }
    for (var v = 0; v < entries.length; v += 1) {
      var nested = findEntry(entries[v][1], aliases, depth + 1);
      if (nested) { return nested; }
    }
    return null;
  }

  function fmtMetric(value) {
    if (value === null || value === undefined) { return "—"; }
    if (typeof value !== "number" || !Number.isFinite(value)) { return "—"; }
    return Math.abs(value) >= 1000 ? value.toFixed(1) : value.toFixed(4);
  }

  /* The gateway answers with entropy_sha (64 hex chars) and poincare_coords
   * (7 floats, or null when math7d is unavailable). Older or mock servers may
   * send numeric entropy / poincare instead, so both are accepted. */
  function displayMetric(entry) {
    if (!entry || entry.value === null || entry.value === undefined) { return "—"; }
    var value = entry.value;
    if (typeof value === "number" && Number.isFinite(value)) { return fmtMetric(value); }
    if (typeof value === "string") {
      return value.length > 18 ? value.slice(0, 16) + "…" : value;
    }
    if (Array.isArray(value)) {
      var nums = value.filter(function (item) {
        return typeof item === "number" && Number.isFinite(item);
      });
      if (!nums.length) { return "—"; }
      var shown = nums.slice(0, 3).map(function (item) { return item.toFixed(3); }).join(", ");
      return nums.length > 3 ? shown + " … (" + nums.length + ")" : shown;
    }
    if (typeof value === "object") {
      var preferred = ["h", "value", "score", "entropy", "poincare"];
      for (var p = 0; p < preferred.length; p += 1) {
        var candidate = value[preferred[p]];
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
          return fmtMetric(candidate);
        }
      }
      var numbers = Object.values(value).filter(function (item) {
        return typeof item === "number" && Number.isFinite(item);
      });
      if (numbers.length) { return fmtMetric(numbers[0]); }
    }
    return "—";
  }

  function metricTitle(entry) {
    if (!entry) { return ""; }
    if (typeof entry.value === "string") { return entry.value; }
    try { return JSON.stringify(entry.value); } catch (err) { return String(entry.value); }
  }

  function renderResponse(data, keepMetrics) {
    var entropy = findEntry(data, ["entropy_sha", "entropy", "entropy_bits",
                                   "shannon_entropy", "shannon"]);
    var poincare = findEntry(data, ["poincare_coords", "poincare", "poincare_h",
                                    "poincareh", "curvature", "hyperbolic_distance"]);
    var entropyUsable = entropy && entropy.value !== null && entropy.value !== undefined;
    var poincareUsable = poincare && poincare.value !== null && poincare.value !== undefined;
    if (!keepMetrics || entropyUsable) {
      els.lastEntropy.textContent = displayMetric(entropy);
      els.lastEntropy.title = metricTitle(entropy);
    }
    if (!keepMetrics || poincareUsable) {
      els.lastPoincare.textContent = displayMetric(poincare);
      els.lastPoincare.title = metricTitle(poincare);
    }
    var text;
    try { text = JSON.stringify(data, null, 2); } catch (err) { text = String(data); }
    els.lastResponse.textContent = text ? text.slice(0, 6000) : "empty response";
  }

  function renderLive(sample) {
    var frame = sample;
    if (!frame) {
      frame = {
        imu: (state.latest.accel || [0, 0, 0]).concat(state.latest.gyro || [0, 0, 0]),
        mag: state.latest.mag || [0, 0, 0],
        env: [state.latest.temp === null ? 0 : state.latest.temp,
              state.latest.pressure === null ? 0 : state.latest.pressure]
      };
    }
    els.liveAccel.textContent = frame.imu.slice(0, 3).map(function (v) { return v.toFixed(2); }).join("  ");
    els.liveGyro.textContent = frame.imu.slice(3, 6).map(function (v) { return v.toFixed(3); }).join("  ");
    els.liveMag.textContent = frame.mag.map(function (v) { return v.toFixed(1); }).join("  ");
    els.liveEnv.textContent = frame.env[0].toFixed(1) + " / " + frame.env[1].toFixed(1);
  }

  function renderCounters() {
    els.samplesSent.textContent = String(state.sent);
    els.batchesSent.textContent = String(state.batches);
    els.queueDepth.textContent = String(state.queue.length);
    els.droppedCount.textContent = String(state.dropped);
  }

  function renderMode() {
    var mode = "idle";
    var label = "IDLE";
    if (state.simulating) { mode = "sim"; label = "SIMULATION"; }
    else if (state.streaming && state.connected) { mode = "live"; label = "LIVE"; }
    else if (state.streaming) { mode = "armed"; label = "ARMED"; }
    else if (state.connected) { mode = "ready"; label = "READY"; }
    els.modeBadge.setAttribute("data-mode", mode);
    els.modeBadge.textContent = label;
    document.body.setAttribute("data-mode", mode);
  }

  function renderControls() {
    els.startBtn.disabled = state.streaming;
    els.stopBtn.disabled = !state.streaming;
    els.simulateBtn.disabled = state.simulating;
    els.stopSimBtn.disabled = !state.simulating;
    els.sendOnceBtn.disabled = !state.connected;
    els.connectBtn.disabled = state.connected;
    els.disconnectBtn.disabled = !state.connected;
  }

  function renderAvailability() {
    var rows = [
      ["motion events", state.sensors.motion, "DeviceMotionEvent"],
      ["orientation", state.sensors.orientation, "DeviceOrientationEvent"],
      ["magnetometer", state.sensors.magnetometer,
        state.sensors.magnetometer ? "Generic Sensor API" : "not streaming"],
      ["pressure", state.sensors.pressure,
        state.sensors.pressure ? "Generic Sensor API" : "not streaming"],
      ["battery", state.sensors.battery, "Battery Status API"],
      ["network", state.sensors.network, "Network Information API"]
    ];
    els.sensorAvailability.textContent = "";
    rows.forEach(function (row) {
      var li = document.createElement("li");
      li.className = row[1] ? "ok" : "unknown";
      var mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = row[1] ? "✓" : "·";
      var name = document.createElement("span");
      name.className = "sensor-name";
      name.textContent = row[0];
      var detail = document.createElement("span");
      detail.className = "sensor-detail";
      detail.textContent = row[2];
      li.appendChild(mark);
      li.appendChild(name);
      li.appendChild(detail);
      els.sensorAvailability.appendChild(li);
    });
    if (!window.isSecureContext) {
      var li = document.createElement("li");
      li.className = "bad";
      li.textContent = "insecure context: browser sensors may be blocked";
      els.sensorAvailability.appendChild(li);
    }
  }

  // -------------------------------------------------------------- streaming

  function restartTimer() {
    if (state.sampleTimer) { window.clearInterval(state.sampleTimer); }
    state.sampleTimer = window.setInterval(tick, Math.max(50, samplePeriodMs()));
  }

  function tick() {
    var sample = buildSample();
    if (!sample) {
      if (!state.warnedNoData) {
        state.warnedNoData = true;
        log("no motion data yet — grant permission on a phone, or use Simulate", "warn");
      }
      return;
    }
    state.warnedNoData = false;
    if (!validSample(sample)) {
      state.dropped += 1;
      log("discarded an invalid sample before sending", "err");
      renderCounters();
      return;
    }
    renderLive(sample);
    state.queue.push(sample);
    if (state.queue.length > MAX_QUEUE) {
      state.queue.shift();
      state.dropped += 1;
    }
    renderCounters();

    if (!state.connected) {
      if (!state.warnedOffline) {
        state.warnedOffline = true;
        log("not connected: samples are queued (max " + MAX_QUEUE + ")", "warn");
      }
      return;
    }
    state.warnedOffline = false;
    if (state.queue.length >= readBatch()) { flushQueue(false); }
  }

  function startStreaming() {
    if (state.streaming) { return; }
    state.streaming = true;
    state.simulating = false;
    state.startedAt = Date.now();
    state.warnedNoData = false;
    restartTimer();
    renderControls();
    renderMode();
    log("streaming at " + readHz() + " Hz, " + readBatch() + " per batch", "ok");
  }

  function stopStreaming(flush) {
    if (state.sampleTimer) {
      window.clearInterval(state.sampleTimer);
      state.sampleTimer = null;
    }
    state.streaming = false;
    state.simulating = false;
    renderControls();
    renderMode();
    if (flush && state.connected && state.queue.length) { flushQueue(true); }
    log("streaming stopped", "info");
  }

  function startSimulation() {
    state.simulating = true;
    state.streaming = true;
    state.startedAt = Date.now();
    state.warnedNoData = false;
    restartTimer();
    renderControls();
    renderMode();
    log("SIMULATION: synthetic samples, rf_fingerprint=sim-web", "warn");
  }

  function sendOnce() {
    if (!state.connected) { log("connect to the gateway first", "warn"); return; }
    var sample = buildSample();
    if (!sample) { log("no sensor frame available; use Simulate", "warn"); return; }
    if (!validSample(sample)) { log("refusing to send an invalid sample", "err"); return; }
    state.queue.push(sample);
    renderCounters();
    flushQueue(true);
  }

  // ------------------------------------------------------------------ send

  function scheduleFlush(delay) {
    if (state.flushTimer) { window.clearTimeout(state.flushTimer); }
    state.flushTimer = window.setTimeout(function () {
      state.flushTimer = null;
      flushQueue(true);
    }, delay);
  }

  function flushQueue(force) {
    if (state.inFlight || !state.connected || !state.queue.length) { return; }
    var batch = readBatch();
    if (!force && state.queue.length < batch) { return; }

    var take = Math.min(state.queue.length, force ? Math.min(batch, MAX_BATCH) : batch);
    var chunk = state.queue.slice(0, take);
    var single = chunk.length === 1;
    var path = single ? PATHS.ingest : PATHS.batch;
    var payload = single ? chunk[0] : { samples: chunk };

    state.inFlight = true;
    api(path, { method: "POST", body: payload }).then(function (data) {
      var accepted = data && Number.isFinite(data.accepted) ? data.accepted : take;
      var rejected = data && Number.isFinite(data.rejected) ? data.rejected : 0;
      accepted = Math.max(0, Math.min(take, Math.floor(accepted)));
      rejected = Math.max(0, Math.min(take - accepted, Math.floor(rejected)));
      state.queue.splice(0, take);
      state.sent += accepted;
      state.dropped += rejected;
      state.batches += 1;
      state.retryDelay = 500;
      setError("");
      renderResponse(data);
      renderCounters();
      if (rejected) {
        log("server rejected " + rejected + " of " + take + " sample(s)" +
            (data && data.error ? ": " + data.error : ""), "warn");
      }
      log("posted " + take + " sample(s) via " + path +
          " (accepted " + accepted + ")", rejected ? "warn" : "ok");
      if (state.queue.length) { scheduleFlush(0); }
    }).catch(function (err) {
      var status = err && err.status;
      if (status === 401 || status === 403) {
        setConnection("unauthorized");
        setError("HTTP " + status + ": token rejected");
        log("HTTP " + status + ": token rejected — check the gateway token", "err");
        scheduleFlush(5000);
      } else if (!status || status === 429 || status >= 500) {
        state.retryDelay = Math.min(15000, state.retryDelay * 2);
        setError(err.message || "network error");
        log("send failed (" + (err.message || "network error") + "); retrying in " +
            Math.round(state.retryDelay / 1000) + "s", "warn");
        scheduleFlush(state.retryDelay);
      } else {
        state.queue.splice(0, take);
        state.dropped += take;
        renderCounters();
        setError(err.message || ("HTTP " + status));
        log("dropped " + take + " sample(s): " + (err.message || ("HTTP " + status)), "err");
        if (state.queue.length) { scheduleFlush(250); }
      }
    }).finally(function () {
      state.inFlight = false;
    });
  }

  // ------------------------------------------------------------ permissions

  function requestMotionPermission() {
    var motionPrompt = typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function";
    var orientationPrompt = typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function";

    if (!motionPrompt && !orientationPrompt) {
      state.permission = "not required";
      els.permissionStatus.textContent = "permission: not required on this browser";
      attachSensorListeners();
      log("no explicit sensor permission API; listeners attached", "info");
      return;
    }

    // Both calls start synchronously so each stays inside the user gesture.
    // iOS rejects a requestPermission() issued from a promise continuation.
    var pending = [];
    if (motionPrompt) { pending.push(DeviceMotionEvent.requestPermission()); }
    if (orientationPrompt) { pending.push(DeviceOrientationEvent.requestPermission()); }
    Promise.all(pending).then(function (results) {
      var granted = results.every(function (result) { return result === "granted"; });
      state.permission = granted ? "granted" : "denied";
      els.permissionStatus.textContent = "permission: " + state.permission;
      if (state.permission === "granted") {
        attachSensorListeners();
        log("motion/orientation permission granted", "ok");
      } else {
        log("motion/orientation permission " + state.permission, "err");
      }
    }).catch(function (err) {
      state.permission = "error";
      els.permissionStatus.textContent = "permission: error";
      log("permission request failed: " + (err.message || err), "err");
    });
  }

  function startMagnetometer() {
    if (state.magSensor) {
      log("magnetometer already running", "info");
      return;
    }
    if (typeof window.Magnetometer !== "function") {
      state.sensors.magnetometer = false;
      renderAvailability();
      log("Magnetometer API is absent; using orientation-derived field " +
          "(approximate, marked in the availability list)", "warn");
      return;
    }
    try {
      var sensor = new window.Magnetometer({ frequency: readHz() });
      sensor.addEventListener("reading", function () {
        state.latest.mag = [num(sensor.x), num(sensor.y), num(sensor.z)];
        state.latest.magAt = performance.now();
        if (!state.sensors.magnetometer) {
          state.sensors.magnetometer = true;
          renderAvailability();
          log("magnetometer streaming", "ok");
        }
        renderLive();
      });
      sensor.addEventListener("error", function (event) {
        state.sensors.magnetometer = false;
        renderAvailability();
        log("magnetometer error: " + (event.error && event.error.name ? event.error.name : "unknown"), "err");
      });
      sensor.start();
      state.magSensor = sensor;
      log("magnetometer requested at " + readHz() + " Hz", "info");
    } catch (err) {
      log("magnetometer could not start: " + (err.message || err), "err");
    }
  }

  function startPressure() {
    if (state.pressureSensor) { return; }
    if (typeof window.PressureSensor !== "function") { return; }
    try {
      var sensor = new window.PressureSensor({ frequency: 1 });
      sensor.addEventListener("reading", function () {
        state.latest.pressure = num(sensor.pressure);
        if (!state.sensors.pressure) {
          state.sensors.pressure = true;
          renderAvailability();
          log("pressure sensor streaming", "ok");
        }
        renderLive();
      });
      sensor.addEventListener("error", function () {
        state.sensors.pressure = false;
        renderAvailability();
      });
      sensor.start();
      state.pressureSensor = sensor;
    } catch (err) {
      log("pressure sensor could not start: " + (err.message || err), "info");
    }
  }

  function attachSensorListeners() {
    if (attachSensorListeners.done) { return; }
    attachSensorListeners.done = true;
    window.addEventListener("devicemotion", onMotion, { passive: true });
    window.addEventListener("deviceorientationabsolute", onOrientation, { passive: true });
    window.addEventListener("deviceorientation", onOrientation, { passive: true });
    startPressure();
  }

  // --------------------------------------------------------------- gateway

  function refreshState() {
    return api(PATHS.state).then(function (data) {
      setConnection("online");
      setError("");
      // A poll must not erase the metrics from the last POST when the state
      // document does not carry them.
      renderResponse(data, true);
      return data;
    }).catch(function (err) {
      if (err.status === 401 || err.status === 403) {
        setConnection("unauthorized");
        setError("HTTP " + err.status + ": token rejected");
        if (state.pollTimer) {
          window.clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      } else {
        setConnection("offline");
        setError(err.message || "gateway unreachable");
      }
      log("GET " + PATHS.state + " failed: " + (err.message || err), "err");
      return null;
    });
  }

  function connect() {
    saveConfig();
    setConnection("connecting");
    setError("");
    refreshState().then(function (data) {
      if (!data) { return; }
      log("connected to " + normalizedBase(), "ok");
      if (state.pollTimer) { window.clearInterval(state.pollTimer); }
      state.pollTimer = window.setInterval(function () {
        if (!state.connected) { return; }
        refreshState();
      }, STATE_POLL_MS);
      if (state.queue.length) { flushQueue(true); }
    });
  }

  function disconnect() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.flushTimer) {
      window.clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    setConnection("idle");
    log("disconnected", "info");
  }

  // ------------------------------------------------------------ environment

  function initBattery() {
    if (!navigator.getBattery) {
      els.batteryStatus.textContent = "unavailable";
      return;
    }
    navigator.getBattery().then(function (battery) {
      state.sensors.battery = true;
      renderAvailability();
      function update() {
        var pct = Math.round(battery.level * 100);
        els.batteryStatus.textContent = pct + "%" + (battery.charging ? " · charging" : "");
      }
      update();
      battery.addEventListener("levelchange", update);
      battery.addEventListener("chargingchange", update);
    }).catch(function () {
      els.batteryStatus.textContent = "unavailable";
    });
  }

  function initNetwork() {
    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    function update() {
      if (!navigator.onLine) {
        els.networkStatus.textContent = "offline";
        return;
      }
      if (!connection) {
        els.networkStatus.textContent = "online";
        return;
      }
      state.sensors.network = true;
      var parts = [connection.effectiveType || "online"];
      if (typeof connection.downlink === "number") { parts.push(connection.downlink + " Mb/s"); }
      if (typeof connection.rtt === "number") { parts.push(connection.rtt + " ms"); }
      els.networkStatus.textContent = parts.join(" · ");
      renderAvailability();
    }
    if (connection && connection.addEventListener) { connection.addEventListener("change", update); }
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  // ------------------------------------------------------------------- init

  function bind() {
    els.connectBtn.addEventListener("click", connect);
    els.disconnectBtn.addEventListener("click", disconnect);
    els.refreshStateBtn.addEventListener("click", function () {
      if (!state.connected) { connect(); } else { refreshState(); }
    });
    els.permissionBtn.addEventListener("click", requestMotionPermission);
    els.magnetometerBtn.addEventListener("click", function () {
      attachSensorListeners();
      startMagnetometer();
    });
    els.startBtn.addEventListener("click", startStreaming);
    els.stopBtn.addEventListener("click", function () { stopStreaming(true); });
    els.sendOnceBtn.addEventListener("click", sendOnce);
    els.simulateBtn.addEventListener("click", startSimulation);
    els.stopSimBtn.addEventListener("click", function () { stopStreaming(true); });
    els.clearLogBtn.addEventListener("click", function () { els.eventLog.textContent = ""; });

    els.baseUrl.addEventListener("change", saveConfig);
    els.token.addEventListener("change", saveConfig);
    els.learnToggle.addEventListener("change", saveConfig);
    els.batchSize.addEventListener("change", function () {
      els.batchSize.value = String(readBatch());
      saveConfig();
    });
    els.sampleHz.addEventListener("change", function () {
      els.sampleHz.value = String(readHz());
      saveConfig();
      if (state.streaming) { restartTimer(); }
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden && state.streaming) {
        log("page hidden; browser may throttle the sample timer", "warn");
      }
    });
  }

  function init() {
    loadConfig();
    bind();
    renderAvailability();
    renderControls();
    renderCounters();
    renderMode();
    renderLive(null);
    attachSensorListeners();

    if (!window.isSecureContext) {
      els.insecureBanner.hidden = false;
      log("insecure context: motion/magnetometer events may be blocked by the browser", "warn");
    }
    if (typeof DeviceMotionEvent === "undefined") {
      log("DeviceMotionEvent is unavailable in this browser", "warn");
    }
    initBattery();
    initNetwork();
    log("sensor client ready; enter the gateway URL and connect", "info");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());
