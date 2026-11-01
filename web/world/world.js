/* ABRASAX // WORLD - Phase 1 client. Zero build, zero dependencies, no CDN.
 *
 * Contract (owned by abrasax.gateway; do not change unilaterally):
 *   GET  /v1/world/state       world snapshot (entities, events_total, rejected, by_origin)
 *   GET  /v1/world/health      {status, checks[], problems[], last_event_age_s, fps_estimate}
 *   GET  /v1/camera/state      camera store counters + frame metadata
 *   POST /v1/sensors/batch     {samples:[{kind, mag[3], imu[6], rf_fingerprint, timestamp, origin, ...}]}
 *   POST /v1/camera/frame      raw image/jpeg body
 *   Authorization: Bearer <token> when the gateway is configured with one
 *
 * Honesty rules enforced here:
 *   - measured (DeviceMotion/Magnetometer) and simulated samples are labelled
 *     by their origin field and never mixed in one batch;
 *   - a synthetic camera placeholder is drawn locally and never uploaded as a
 *     measured frame;
 *   - missing values stay null / "--", never zero-filled to look real;
 *   - the token lives in sessionStorage only and is redacted from every log.
 */
(function () {
  "use strict";

  var POLL_MS = 1000;
  var REQUEST_TIMEOUT_MS = 6000;
  var MAX_BATCH = 256;
  var MAX_QUEUE = 512;
  var MAX_LOG = 200;
  var RETRY_BASE_MS = 600;
  var RETRY_MAX_MS = 20000;

  var PATHS = {
    worldState: "/v1/world/state",
    worldHealth: "/v1/world/health",
    cameraState: "/v1/camera/state",
    sensorsBatch: "/v1/sensors/batch",
    cameraFrame: "/v1/camera/frame"
  };

  var STORE = {
    baseUrl: "abrasax.world.baseUrl",
    token: "abrasax.world.token",
    hz: "abrasax.world.hz",
    batch: "abrasax.world.batch",
    fps: "abrasax.world.cameraFps"
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    baseUrl: $("baseUrl"),
    token: $("token"),
    connectBtn: $("connectBtn"),
    disconnectBtn: $("disconnectBtn"),
    pollToggle: $("pollToggle"),
    motionBtn: $("motionBtn"),
    simulateBtn: $("simulateBtn"),
    stopSimBtn: $("stopSimBtn"),
    motionState: $("motionState"),
    modeBadge: $("modeBadge"),
    connectionDot: $("connectionDot"),
    connectionState: $("connectionState"),
    lastHttp: $("lastHttp"),
    lastError: $("lastError"),
    authBanner: $("authBanner"),
    insecureBanner: $("insecureBanner"),

    worldEventsTotal: $("worldEventsTotal"),
    worldRejected: $("worldRejected"),
    worldEntities: $("worldEntities"),
    worldHistory: $("worldHistory"),
    worldByOrigin: $("worldByOrigin"),
    entityTable: $("entityTable"),
    entityCount: $("entityCount"),

    poseRoll: $("poseRoll"),
    posePitch: $("posePitch"),
    poseYaw: $("poseYaw"),
    poseStatus: $("poseStatus"),
    poseSource: $("poseSource"),
    poseSync: $("poseSync"),
    posePosition: $("posePosition"),
    poseVelocity: $("poseVelocity"),
    poseUncertainty: $("poseUncertainty"),
    poseSamples: $("poseSamples"),

    freshnessAge: $("freshnessAge"),
    freshnessSource: $("freshnessSource"),
    sensorSamplesSent: $("sensorSamplesSent"),
    sensorBatchesSent: $("sensorBatchesSent"),
    sensorQueue: $("sensorQueue"),
    captureHz: $("captureHz"),
    batchSize: $("batchSize"),
    sensorAvailability: $("sensorAvailability"),

    cameraState: $("cameraState"),
    cameraCounts: $("cameraCounts"),
    cameraLast: $("cameraLast"),
    cameraFrames: $("cameraFrames"),
    cameraLastError: $("cameraLastError"),

    cameraVideo: $("cameraVideo"),
    cameraCanvas: $("cameraCanvas"),
    cameraOverlay: $("cameraOverlay"),
    cameraStartBtn: $("cameraStartBtn"),
    cameraStopBtn: $("cameraStopBtn"),
    cameraFps: $("cameraFps"),
    cameraSimNote: $("cameraSimNote"),

    healthStatus: $("healthStatus"),
    healthLast: $("healthLast"),
    healthChecks: $("healthChecks"),
    healthProblems: $("healthProblems"),

    eventLog: $("eventLog"),
    clearLogBtn: $("clearLogBtn"),
    logCount: $("logCount")
  };

  var state = {
    connected: false,
    connecting: false,
    polling: false,
    authNotified: false,
    baseUrl: "http://127.0.0.1:9001",
    mode: "idle",
    pollTimer: null,
    lastErrorText: "",
    pollFailures: 0,

    simulating: false,
    captureTimer: null,
    simStep: 0,
    simFrameStep: 0,
    sensorSeq: 0,
    queue: [],
    sending: false,
    sent: 0,
    batches: 0,
    retryDelay: RETRY_BASE_MS,
    backoffUntil: 0,

    motionEnabled: false,
    motionListening: false,
    motionLogged: false,
    latest: { accel: null, gyro: null, mag: null, orientation: null, at: 0 },
    localPose: null,
    localPoseSamples: 0,
    magSensor: null,

    camera: {
      stream: null,
      running: false,
      synthetic: false,
      timer: null,
      frames: 0,
      lastPostAt: 0,
      lastError: "",
      posting: false
    }
  };

  // ------------------------------------------------------------------ utils

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function clampInt(value, low, high, fallback) {
    if (value === "" || value === null || value === undefined) { return fallback; }
    var n = Math.round(Number(value));
    if (!Number.isFinite(n)) { return fallback; }
    return Math.min(high, Math.max(low, n));
  }

  function readHz() { return clampInt(els.captureHz && els.captureHz.value, 1, 30, 10); }
  function readBatch() { return clampInt(els.batchSize && els.batchSize.value, 1, MAX_BATCH, 10); }
  function readFps() { return clampInt(els.cameraFps && els.cameraFps.value, 1, 15, 2); }

  function setText(el, text) {
    if (!el) { return; }
    el.textContent = (text === null || text === undefined || text === "") ? "--" : String(text);
  }

  function fmtNum(value, digits) {
    if (value === null || value === undefined || value === "") { return "--"; }
    var n = Number(value);
    if (!Number.isFinite(n)) { return "--"; }
    return digits === undefined ? String(n) : n.toFixed(digits);
  }

  function fmtAge(seconds) {
    var n = Number(seconds);
    if (!Number.isFinite(n)) { return "--"; }
    if (n < 1) { return (n * 1000).toFixed(0) + " ms"; }
    if (n < 120) { return n.toFixed(2) + " s"; }
    return (n / 60).toFixed(1) + " min";
  }

  function isoNow() {
    return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1Z");
  }

  function redact(text) {
    var out = String(text === null || text === undefined ? "" : text);
    var token = (els.token && els.token.value ? els.token.value : "").trim();
    if (token) { out = out.split(token).join("[redacted]"); }
    return out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
  }

  function log(message, level) {
    if (!els.eventLog) { return; }
    var li = document.createElement("li");
    li.setAttribute("data-level", level || "info");
    var t = document.createElement("span");
    t.className = "log-time";
    var d = new Date();
    t.textContent = d.toTimeString().slice(0, 8);
    var l = document.createElement("span");
    l.className = "log-level";
    l.textContent = level || "info";
    var m = document.createElement("span");
    m.className = "log-msg";
    m.textContent = redact(message);
    li.appendChild(t);
    li.appendChild(l);
    li.appendChild(m);
    els.eventLog.appendChild(li);
    while (els.eventLog.children.length > MAX_LOG) {
      els.eventLog.removeChild(els.eventLog.firstChild);
    }
    els.eventLog.scrollTop = els.eventLog.scrollHeight;
    if (els.logCount) { els.logCount.textContent = els.eventLog.children.length + " lines"; }
  }

  function setMode(mode, detail) {
    state.mode = mode;
    document.body.setAttribute("data-mode", mode);
    if (els.modeBadge) {
      els.modeBadge.setAttribute("data-mode", mode);
      els.modeBadge.textContent = mode === "sim" ? "SIMULATE" :
        (mode === "live" ? "LIVE" : (mode === "error" ? "ERROR" : "IDLE"));
    }
    if (els.connectionDot) {
      els.connectionDot.setAttribute("data-state", mode === "live" ? "live" :
        (mode === "sim" ? "sim" : (mode === "error" ? "error" : "idle")));
    }
    if (els.connectionState) {
      els.connectionState.textContent = detail || (mode === "sim" ? "SIMULATE - synthetic, not measured" :
        (mode === "live" ? "connected - polling 1 s" :
          (mode === "error" ? "error - see event log" : "not connected")));
    }
    updateControls();
  }

  function updateControls() {
    if (els.connectBtn) { els.connectBtn.disabled = state.connected || state.connecting; }
    if (els.disconnectBtn) { els.disconnectBtn.disabled = !state.connected && !state.simulating; }
    if (els.simulateBtn) {
      els.simulateBtn.disabled = state.simulating;
      els.simulateBtn.classList.toggle("active", state.simulating);
    }
    if (els.stopSimBtn) { els.stopSimBtn.disabled = !state.simulating; }
    if (els.motionBtn) { els.motionBtn.disabled = state.simulating; }
    if (els.cameraStartBtn) { els.cameraStartBtn.disabled = state.camera.running; }
    if (els.cameraStopBtn) { els.cameraStopBtn.disabled = !state.camera.running; }
    if (els.lastError) { els.lastError.textContent = state.lastErrorText || "--"; }
  }

  function noteError(message) {
    state.lastErrorText = redact(message);
    if (els.lastError) { els.lastError.textContent = state.lastErrorText; }
  }

  function clearError() {
    state.lastErrorText = "";
    if (els.lastError) { els.lastError.textContent = "--"; }
  }

  // ------------------------------------------------------------------ http

  function normalizeBase(raw) {
    var value = String(raw || "").trim();
    if (!value) { value = "http://127.0.0.1:9001"; }
    if (!/^https?:\/\//i.test(value)) { value = "http://" + value; }
    var url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("base URL must be http:// or https://");
    }
    return url.href.replace(/\/+$/, "");
  }

  function authHeaders(extra) {
    var headers = {};
    var key;
    if (extra) { for (key in extra) { if (Object.prototype.hasOwnProperty.call(extra, key)) { headers[key] = extra[key]; } } }
    var token = (els.token && els.token.value ? els.token.value : "").trim();
    if (token) { headers.Authorization = "Bearer " + token; }
    return headers;
  }

  function request(path, options) {
    options = options || {};
    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = null;
    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    }
    var init = {
      method: options.method || "GET",
      headers: authHeaders(options.headers),
      cache: "no-store"
    };
    if (options.body !== undefined) { init.body = options.body; }
    if (controller) { init.signal = controller.signal; }

    var started = (window.performance && performance.now) ? performance.now() : Date.now();
    return fetch(state.baseUrl + path, init).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        if (text) {
          try { body = JSON.parse(text); } catch (err) { body = null; }
        }
        var elapsed = Math.round(((window.performance && performance.now) ?
          performance.now() : Date.now()) - started);
        setText(els.lastHttp, res.status + " - " + elapsed + " ms - " + path);
        if (res.status === 401) { onUnauthorized(); }
        return {
          ok: res.ok, status: res.status, body: body, text: text,
          contentType: res.headers.get("Content-Type") || "", ms: elapsed
        };
      });
    }).catch(function (err) {
      var message = err && err.name === "AbortError" ?
        "request timed out after " + REQUEST_TIMEOUT_MS + " ms" :
        ((err && err.message) || String(err));
      setText(els.lastHttp, "transport error - " + path);
      noteError(message + " (" + path + ")");
      return { ok: false, status: 0, body: null, text: "", error: message };
    }).then(function (result) {
      if (timer) { clearTimeout(timer); }
      return result;
    });
  }

  function onUnauthorized() {
    if (els.authBanner) { els.authBanner.hidden = false; }
    noteError("401 unauthorized: set the gateway token and press Connect");
    if (!state.authNotified) {
      state.authNotified = true;
      log("401 unauthorized - gateway token missing or wrong. Token is not logged.", "error");
    }
    state.connected = false;
    state.simulating = false;
    state.localPose = null;
    state.localPoseSamples = 0;
    renderPose(null, "--");
    stopPolling();
    haltStreams();
    setMode("error", "401 unauthorized - token required");
  }

  function bodyError(body, fallback) {
    if (body && typeof body === "object") {
      if (body.error && body.error.message) { return String(body.error.message); }
      if (typeof body.error === "string") { return body.error; }
      if (body.message) { return String(body.message); }
    }
    return fallback;
  }

  // ------------------------------------------------------------------ connect

  function saveInputs() {
    try {
      sessionStorage.setItem(STORE.baseUrl, String(els.baseUrl && els.baseUrl.value ? els.baseUrl.value : state.baseUrl).trim());
      sessionStorage.setItem(STORE.token, (els.token && els.token.value ? els.token.value : "").trim());
      sessionStorage.setItem(STORE.hz, String(readHz()));
      sessionStorage.setItem(STORE.batch, String(readBatch()));
      sessionStorage.setItem(STORE.fps, String(readFps()));
    } catch (err) { /* private mode: inputs still work for this page */ }
  }

  function restoreInputs() {
    try {
      var base = sessionStorage.getItem(STORE.baseUrl);
      var token = sessionStorage.getItem(STORE.token);
      var hz = sessionStorage.getItem(STORE.hz);
      var batch = sessionStorage.getItem(STORE.batch);
      var fps = sessionStorage.getItem(STORE.fps);
      if (base) { els.baseUrl.value = base; }
      if (token) { els.token.value = token; }
      if (hz) { els.captureHz.value = hz; }
      if (batch) { els.batchSize.value = batch; }
      if (fps) { els.cameraFps.value = fps; }
    } catch (err) { /* no sessionStorage: defaults apply */ }
  }

  function connect(silent) {
    if (state.connecting) { return; }
    var base;
    try {
      base = normalizeBase(els.baseUrl.value);
    } catch (err) {
      noteError(err.message);
      log(err.message, "error");
      setMode("error", "invalid base URL");
      return;
    }
    state.baseUrl = base;
    els.baseUrl.value = base;
    saveInputs();
    state.connecting = true;
    updateControls();
    if (!silent) { log("connecting to " + base); }
    setMode("idle", "connecting...");

    request(PATHS.worldState).then(function (res) {
      state.connecting = false;
      if (res.status === 401) {
        updateControls();
        return;
      }
      if (!res.ok) {
        state.connected = false;
        noteError("connect failed: HTTP " + (res.status || "transport") + " " +
          bodyError(res.body, res.error || ""));
        log("connect failed: " + bodyError(res.body, res.error || ("HTTP " + res.status)), "error");
        setMode("error", "gateway unreachable or route missing");
        updateControls();
        return;
      }
      state.connected = true;
      state.authNotified = false;
      state.pollFailures = 0;
      clearError();
      if (els.authBanner) { els.authBanner.hidden = true; }
      renderState(res.body);
      log("connected: " + base + " (world state ok)");
      setMode(state.simulating ? "sim" : "live");
      startPolling();
      pollOnce();
      updateControls();
    });
  }

  function disconnect() {
    state.connected = false;
    state.localPose = null;
    state.localPoseSamples = 0;
    renderPose(null, "--");
    stopPolling();
    stopSimulation(true);
    stopCamera(true);
    state.motionEnabled = false;
    clearTimers();
    clearError();
    if (els.authBanner) { els.authBanner.hidden = true; }
    log("disconnected");
    setMode("idle");
  }

  function startPolling() {
    stopPolling();
    if (!els.pollToggle || !els.pollToggle.checked) { return; }
    state.pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function pollOnce() {
    if (!state.connected || state.polling) { return; }
    if (els.pollToggle && !els.pollToggle.checked) { return; }
    state.polling = true;
    Promise.all([
      request(PATHS.worldState),
      request(PATHS.worldHealth),
      request(PATHS.cameraState)
    ]).then(function (results) {
      var s = results[0];
      var h = results[1];
      var c = results[2];
      if (s.status === 401 || h.status === 401) { return; }
      if (s.ok) {
        state.pollFailures = 0;
        state.connected = true;
        clearError();
        if (els.authBanner) { els.authBanner.hidden = true; }
        renderState(s.body);
        if (state.mode !== "sim") { setMode("live"); }
      } else {
        state.pollFailures += 1;
        if (state.pollFailures === 1 || state.pollFailures % 15 === 0) {
          noteError("world state: " + bodyError(s.body, s.error || ("HTTP " + s.status)));
          log("world state poll failed: " + bodyError(s.body, s.error || ("HTTP " + s.status)), "warn");
        }
      }
      if (h.ok) { renderHealth(h.body); }
      else if (h.status !== 404) {
        if (state.pollFailures <= 1) {
          log("world health poll failed: " + bodyError(h.body, h.error || ("HTTP " + h.status)), "warn");
        }
      }
      if (c.ok) { renderCameraState(c.body); }
    }).then(function () {
      state.polling = false;
      state.connecting = false;
      updateControls();
    }, function () {
      state.polling = false;
    });
  }

  // ------------------------------------------------------------------ render

  function worldOf(body) {
    if (!body || typeof body !== "object") { return {}; }
    if (body.world && typeof body.world === "object") { return body.world; }
    if (body.state && typeof body.state === "object") { return body.state; }
    if (body.snapshot && typeof body.snapshot === "object") { return body.snapshot; }
    return body;
  }

  function poseOf(body, world) {
    if (body && body.pose && typeof body.pose === "object") { return body.pose; }
    if (body && body.fusion && typeof body.fusion === "object") { return body.fusion; }
    if (body && body.fusion_state && typeof body.fusion_state === "object") { return body.fusion_state; }
    if (world && world.pose && typeof world.pose === "object") { return world.pose; }
    if (body && typeof body.roll !== "undefined" && typeof body.status === "string") { return body; }
    return null;
  }

  function renderState(body) {
    var world = worldOf(body);
    setText(els.worldEventsTotal, fmtNum(world.events_total, 0));
    setText(els.worldRejected, fmtNum(world.rejected, 0));
    var entities = (world.entities && typeof world.entities === "object") ? world.entities : {};
    var keys = Object.keys(entities);
    setText(els.worldEntities, String(keys.length));
    setText(els.worldHistory, fmtNum(world.history_len, 0));
    renderByOrigin(world.by_origin);
    renderEntities(entities, keys);
    var serverPose = poseOf(body, world);
    if (serverPose) {
      renderPose(serverPose, "gateway fusion");
    } else if (state.localPose) {
      renderPose(state.localPose, "local derivation (not authoritative)");
    } else {
      renderPose(null, "--");
    }
    renderCameraInline(body);
    if (body && typeof body.last_event_age_s !== "undefined") {
      setText(els.freshnessAge, fmtAge(body.last_event_age_s));
      setText(els.freshnessSource, "world state report");
    }
  }

  function renderByOrigin(byOrigin) {
    if (!els.worldByOrigin) { return; }
    els.worldByOrigin.textContent = "";
    var entries = [];
    if (byOrigin && typeof byOrigin === "object") {
      var name;
      for (name in byOrigin) {
        if (Object.prototype.hasOwnProperty.call(byOrigin, name)) {
          entries.push([name, byOrigin[name]]);
        }
      }
    }
    if (!entries.length) {
      var none = document.createElement("li");
      none.className = "pending";
      none.textContent = "no events yet";
      els.worldByOrigin.appendChild(none);
      return;
    }
    entries.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
    entries.forEach(function (entry) {
      var li = document.createElement("li");
      li.setAttribute("data-origin", String(entry[0]));
      li.textContent = String(entry[0]);
      var b = document.createElement("b");
      b.textContent = fmtNum(entry[1], 0);
      li.appendChild(b);
      els.worldByOrigin.appendChild(li);
    });
  }

  function entityAgeLabel(entity) {
    if (entity && typeof entity.last_seen_age_s === "number") { return fmtAge(entity.last_seen_age_s); }
    if (entity && typeof entity.age_s === "number") { return fmtAge(entity.age_s); }
    if (entity && typeof entity.latest_ts_origin === "string" && entity.latest_ts_origin) {
      return entity.latest_ts_origin.replace("T", " ").replace(/\.\d+Z?$/, "Z");
    }
    return "--";
  }

  function renderEntities(entities, keys) {
    if (!els.entityTable) { return; }
    els.entityTable.textContent = "";
    setText(els.entityCount, keys.length ? "(" + keys.length + ")" : "");
    if (!keys.length) {
      var empty = document.createElement("tr");
      var cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "pending";
      cell.textContent = "no entities ingested";
      empty.appendChild(cell);
      els.entityTable.appendChild(empty);
      return;
    }
    keys.sort(function (a, b) {
      var ea = entities[a] || {};
      var eb = entities[b] || {};
      var sa = Number(ea.last_seen_ns || 0);
      var sb = Number(eb.last_seen_ns || 0);
      if (sa !== sb) { return sb - sa; }
      return String(a).localeCompare(String(b));
    });
    keys.slice(0, 60).forEach(function (key) {
      var e = entities[key] || {};
      var tr = document.createElement("tr");
      var cells = [
        String(key),
        String(e.origin || "--"),
        fmtNum(e.count, 0),
        fmtNum(e.latest_seq, 0),
        String(e.quality || "--"),
        String(e.sync_status || "--"),
        entityAgeLabel(e)
      ];
      cells.forEach(function (text, index) {
        var td = document.createElement("td");
        td.textContent = text;
        if (index === 1) { td.setAttribute("data-origin", text); }
        if (index === 5) { td.setAttribute("data-sync", text); }
        tr.appendChild(td);
      });
      els.entityTable.appendChild(tr);
    });
  }

  function toDeg(value) {
    if (value === null || value === undefined) { return null; }
    var n = Number(value);
    if (!Number.isFinite(n)) { return null; }
    return n * 180 / Math.PI;
  }

  function vector3(value) {
    if (!value) { return null; }
    if (Array.isArray(value) && value.length >= 3) { return value.slice(0, 3).map(num); }
    if (typeof value === "object") { return [num(value.x), num(value.y), num(value.z)]; }
    return null;
  }

  function renderPose(pose, source) {
    setText(els.poseSource, source || "gateway fusion");
    if (!pose) {
      setText(els.poseRoll, "--");
      setText(els.posePitch, "--");
      setText(els.poseYaw, "--");
      setText(els.poseStatus, "insufficient");
      setText(els.poseSync, "unsynced");
      setText(els.posePosition, "--");
      setText(els.poseVelocity, "--");
      setText(els.poseUncertainty, "--");
      setText(els.poseSamples, "--");
      return;
    }
    var roll = toDeg(pose.roll);
    var pitch = toDeg(pose.pitch);
    var yaw = toDeg(pose.yaw);
    setText(els.poseRoll, roll === null ? "--" : fmtNum(roll, 2));
    setText(els.posePitch, pitch === null ? "--" : fmtNum(pitch, 2));
    setText(els.poseYaw, yaw === null ? "--" : fmtNum(yaw, 2));
    setText(els.poseStatus, pose.status || "insufficient");
    setText(els.poseSync, pose.sync_status || "unsynced");
    var position = vector3(pose.position);
    setText(els.posePosition, position ? position.map(function (v) { return fmtNum(v, 2); }).join(", ") : "--");
    var velocity = vector3(pose.velocity);
    setText(els.poseVelocity, velocity ? velocity.map(function (v) { return fmtNum(v, 2); }).join(", ") : "--");
    setText(els.poseUncertainty, uncertaintyLabel(pose.uncertainty));
    var samples = fmtNum(pose.samples, 0);
    var rejected = fmtNum(pose.rejected, 0);
    setText(els.poseSamples, samples + " / " + rejected);
  }

  function uncertaintyLabel(value) {
    if (value === null || value === undefined) { return "--"; }
    if (typeof value === "number") { return fmtNum(value, 3); }
    if (typeof value === "string") { return value; }
    if (typeof value === "object") {
      var parts = [];
      var key;
      for (key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          var v = value[key];
          if (v === null || v === undefined) { continue; }
          parts.push(key + "=" + (typeof v === "number" ? fmtNum(v, 3) : String(v)));
        }
      }
      return parts.length ? parts.join("  ") : "--";
    }
    return String(value);
  }

  function deriveLocalPose(sample) {
    if (!sample || !sample.imu || !sample.mag) { return null; }
    if (sample.imu.length < 6 || sample.mag.length < 3) { return null; }
    var ax = num(sample.imu[0]);
    var ay = num(sample.imu[1]);
    var az = num(sample.imu[2]);
    var mx = num(sample.mag[0]);
    var my = num(sample.mag[1]);
    var mz = num(sample.mag[2]);
    var accelNorm = Math.sqrt(ax * ax + ay * ay + az * az);
    var magNorm = Math.sqrt(mx * mx + my * my + mz * mz);
    if (accelNorm < 0.5 || magNorm < 5.0) { return null; }
    var roll = Math.atan2(ay, az);
    var pitch = Math.atan2(-ax, Math.sqrt(ay * ay + az * az));
    var sinR = Math.sin(roll);
    var cosR = Math.cos(roll);
    var sinP = Math.sin(pitch);
    var cosP = Math.cos(pitch);
    var xh = mx * cosP + my * sinR * sinP + mz * cosR * sinP;
    var yh = my * cosR - mz * sinR;
    var yaw = Math.atan2(-yh, xh);
    var tiltErrorDeg = Math.abs(accelNorm - 9.80665) / 9.80665 * 57.2958;
    var headingErrorDeg = Math.abs(magNorm - 49.0) / 49.0 * 57.2958;
    return {
      roll: roll,
      pitch: pitch,
      yaw: yaw,
      position: sample.position || null,
      velocity: sample.velocity || null,
      uncertainty: {
        tilt_deg: Math.round(tiltErrorDeg * 100) / 100,
        heading_deg: Math.round(headingErrorDeg * 100) / 100
      },
      last_update_ns: Date.now() * 1e6,
      sync_status: "unsynced",
      status: "derived",
      samples: state.localPoseSamples,
      rejected: 0,
      origin: sample.origin || null,
      local: true
    };
  }

  function renderCameraInline(body) {
    if (!body || !body.camera || typeof body.camera !== "object") { return; }
    if (body.camera.state && typeof body.camera.state === "object") {
      renderCameraState(body.camera.state);
    }
    if (body.sensors && body.sensors.last) {
      var last = body.sensors.last;
      if (last.received_at) {
        setText(els.freshnessAge, "last sensor " + String(last.received_at).replace("T", " ").replace(/Z$/, "Z"));
        setText(els.freshnessSource, "sensor store");
      }
    }
  }

  function renderCameraState(body) {
    if (!body || typeof body !== "object") { return; }
    var store = body.camera ? body.camera : body;
    if (typeof store.count !== "undefined") {
      setText(els.cameraState, fmtNum(store.count, 0) + " / " + fmtNum(store.capacity, 0) + " frames");
    } else {
      setText(els.cameraState, "--");
    }
    setText(els.cameraCounts, fmtNum(store.accepted, 0) + " / " + fmtNum(store.rejected, 0));
    var last = store.last;
    if (last && typeof last === "object") {
      var stamp = last.ts_utc || last.received_at || last.ts_origin || "";
      var sha = last.sha256 ? String(last.sha256).slice(0, 12) : "";
      setText(els.cameraLast, (stamp ? String(stamp).replace("T", " ").replace(/Z$/, "Z") : "--") +
        (sha ? "  sha " + sha : ""));
    } else {
      setText(els.cameraLast, "no frames");
    }
    setText(els.cameraLastError, store.last_error || "--");
    if (store.last_error) { state.camera.lastError = String(store.last_error); }
  }

  function renderHealth(body) {
    var report = (body && body.health && typeof body.health === "object") ? body.health : body;
    if (!report || typeof report !== "object") { return; }
    var status = String(report.status || "unknown");
    if (status !== "ok" && status !== "degraded" && status !== "critical") { status = "unknown"; }
    if (els.healthStatus) {
      els.healthStatus.setAttribute("data-status", status);
      els.healthStatus.textContent = status.toUpperCase();
    }
    document.body.setAttribute("data-health", status);
    if (els.healthLast) {
      var bits = ["GET /v1/world/health"];
      if (typeof report.last_event_age_s !== "undefined") {
        bits.push("last event " + fmtAge(report.last_event_age_s));
      }
      if (typeof report.fps_estimate === "number") {
        bits.push(fmtNum(report.fps_estimate, 2) + " Hz");
      }
      els.healthLast.textContent = bits.join("  ·  ");
    }
    if (typeof report.last_event_age_s !== "undefined") {
      setText(els.freshnessAge, fmtAge(report.last_event_age_s));
      setText(els.freshnessSource, "world health report");
    }
    renderChecks(report.checks);
    renderProblems(report.problems);
  }

  function renderChecks(checks) {
    if (!els.healthChecks) { return; }
    els.healthChecks.textContent = "";
    if (!Array.isArray(checks) || !checks.length) {
      var pending = document.createElement("li");
      pending.className = "pending";
      pending.textContent = "no checks in report";
      els.healthChecks.appendChild(pending);
      return;
    }
    checks.forEach(function (check) {
      if (!check || typeof check !== "object") { return; }
      var li = document.createElement("li");
      var checkStatus = String(check.status || "unknown");
      li.setAttribute("data-status", checkStatus);
      var name = document.createElement("span");
      name.className = "check-name";
      name.textContent = String(check.name || "check");
      var st = document.createElement("span");
      st.className = "check-state";
      st.textContent = checkStatus;
      var detail = document.createElement("span");
      detail.className = "check-detail";
      detail.textContent = String(check.detail || "");
      li.appendChild(name);
      li.appendChild(st);
      li.appendChild(detail);
      els.healthChecks.appendChild(li);
    });
  }

  function renderProblems(problems) {
    if (!els.healthProblems) { return; }
    els.healthProblems.textContent = "";
    if (!Array.isArray(problems) || !problems.length) {
      var none = document.createElement("li");
      none.className = "pending";
      none.textContent = "none observed";
      els.healthProblems.appendChild(none);
      return;
    }
    problems.forEach(function (problem) {
      var li = document.createElement("li");
      li.textContent = String(problem);
      els.healthProblems.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ motion

  function updateAvailability() {
    if (!els.sensorAvailability) { return; }
    els.sensorAvailability.textContent = "";
    var secure = (window.isSecureContext !== false);
    var items = [
      ["DeviceMotionEvent", ("DeviceMotionEvent" in window) ? "on" : "off",
        ("DeviceMotionEvent" in window) ? "accelerometer + gyroscope" : "not exposed by this browser"],
      ["DeviceOrientationEvent", ("DeviceOrientationEvent" in window) ? "on" : "off",
        ("DeviceOrientationEvent" in window) ? "roll / pitch / yaw events" : "not exposed"],
      ["Magnetometer", ("Magnetometer" in window) ? "on" : "off",
        ("Magnetometer" in window) ? "Generic Sensor API" : "not exposed (use Termux)"],
      ["getUserMedia", (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? "on" : "off",
        (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? "camera capture" : "unavailable"],
      ["secure context", secure ? "on" : "off",
        secure ? "sensor and camera APIs permitted" : "plain http: Android may block capture"]
    ];
    items.forEach(function (item) {
      var li = document.createElement("li");
      li.setAttribute("data-state", item[1]);
      var name = document.createElement("span");
      name.textContent = item[0];
      var detail = document.createElement("span");
      detail.textContent = item[2];
      li.appendChild(name);
      li.appendChild(detail);
      els.sensorAvailability.appendChild(li);
    });
    if (els.motionState) {
      els.motionState.textContent = "motion: " +
        (state.motionEnabled ? "streaming" : "not requested") +
        "  ·  magnetometer: " + (state.magSensor ? "streaming" : "off");
    }
  }

  function orientationPermission() {
    var chain = Promise.resolve(true);
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function") {
      chain = chain.then(function () { return DeviceMotionEvent.requestPermission(); })
        .then(function (answer) { return answer === "granted"; });
    }
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      chain = chain.then(function () { return DeviceOrientationEvent.requestPermission(); })
        .then(function (answer) { return answer === "granted"; });
    }
    return chain.catch(function () { return false; });
  }

  function onMotion(event) {
    var accel = event.accelerationIncludingGravity || event.acceleration;
    var gyro = event.rotationRate;
    if (accel) {
      state.latest.accel = [num(accel.x), num(accel.y), num(accel.z)];
    }
    if (gyro) {
      // rotationRate is degrees/second in the device frame: alpha=z, beta=x, gamma=y.
      state.latest.gyro = [
        num(gyro.beta) * Math.PI / 180,
        num(gyro.gamma) * Math.PI / 180,
        num(gyro.alpha) * Math.PI / 180
      ];
    }
    state.latest.at = Date.now();
    if (!state.motionLogged) {
      state.motionLogged = true;
      log("DeviceMotion active - measured samples will be posted as origin=measured");
    }
  }

  function onOrientation(event) {
    state.latest.orientation = [num(event.alpha), num(event.beta), num(event.gamma)];
  }

  function startMagnetometer() {
    if (!("Magnetometer" in window)) { return; }
    try {
      var sensor = new Magnetometer({ frequency: readHz() });
      sensor.addEventListener("reading", function () {
        state.latest.mag = [num(sensor.x), num(sensor.y), num(sensor.z)];
      });
      sensor.addEventListener("error", function (event) {
        log("magnetometer error: " + ((event.error && event.error.name) || "unknown"), "warn");
      });
      sensor.start();
      state.magSensor = sensor;
    } catch (err) {
      log("magnetometer unavailable: " + ((err && err.message) || err), "warn");
    }
  }

  function enableMotion() {
    if (state.simulating) {
      log("stop SIMULATE before enabling measured sensors", "warn");
      return;
    }
    orientationPermission().then(function (granted) {
      if (!granted) {
        log("motion permission denied - use the Termux forwarder instead", "warn");
        if (els.motionState) { els.motionState.textContent = "motion: permission denied"; }
        return;
      }
      if (!state.motionListening) {
        if (typeof DeviceMotionEvent !== "undefined") {
          window.addEventListener("devicemotion", onMotion, { passive: true });
        }
        if (typeof DeviceOrientationEvent !== "undefined") {
          window.addEventListener("deviceorientation", onOrientation, { passive: true });
        }
        state.motionListening = true;
      }
      state.motionEnabled = true;
      startMagnetometer();
      updateAvailability();
      log("motion enabled at " + readHz() + " Hz");
      if (!state.captureTimer) { startCaptureLoop(); }
      if (!state.connected) { log("not connected - samples queue locally until Connect", "warn"); }
    });
  }

  function measuredSample() {
    if (!state.latest.accel) { return null; }
    var gyro = state.latest.gyro || [0, 0, 0];
    var mag = state.latest.mag || [0, 0, 0];
    var sample = {
      kind: "sensor",
      provider_id: "web-world",
      sensor_id: "phone",
      origin: "measured",
      seq: state.sensorSeq++,
      timestamp: isoNow(),
      imu: [
        state.latest.accel[0], state.latest.accel[1], state.latest.accel[2],
        gyro[0], gyro[1], gyro[2]
      ],
      mag: [mag[0], mag[1], mag[2]],
      rf_fingerprint: "web-world"
    };
    return sample;
  }

  // ------------------------------------------------------------------ sim

  /* Deterministic pseudo-noise: same step -> same value, no Math.random. */
  function pseudo(step, channel) {
    var x = (Math.imul(step + 1, 1664525) + Math.imul(channel + 1, 1013904223) +
      Math.imul(channel + 7, 2654435761)) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 2246822507) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 3266489909) >>> 0;
    x ^= x >>> 16;
    return ((x >>> 0) / 4294967295) * 2 - 1;
  }

  function syntheticSample(step) {
    var t = step / readHz();
    var roll = 0.20 * Math.sin(t * 0.71) + 0.012 * pseudo(step, 1);
    var pitch = 0.13 * Math.cos(t * 0.53) + 0.012 * pseudo(step, 2);
    var yaw = (t * 0.37) % (Math.PI * 2);
    var gx = 0.05 * Math.cos(t * 0.71) + 0.004 * pseudo(step, 3);
    var gy = -0.04 * Math.sin(t * 0.53) + 0.004 * pseudo(step, 4);
    var gz = 0.03 * Math.sin(t * 0.19) + 0.003 * pseudo(step, 5);
    var ax = 9.81 * Math.sin(pitch) + 0.03 * pseudo(step, 6);
    var ay = -9.81 * Math.sin(roll) * Math.cos(pitch) + 0.03 * pseudo(step, 7);
    var az = 9.81 * Math.cos(roll) * Math.cos(pitch) + 0.03 * pseudo(step, 8);
    var mx = 49.0 * Math.cos(yaw) + 0.4 * pseudo(step, 9);
    var my = 49.0 * Math.sin(yaw) + 0.4 * pseudo(step, 10);
    var mz = 3.0 + 0.8 * Math.sin(t * 0.31) + 0.2 * pseudo(step, 11);
    return {
      kind: "sensor",
      provider_id: "web-sim",
      sensor_id: "phone",
      origin: "simulated",
      seq: state.sensorSeq++,
      timestamp: isoNow(),
      imu: [ax, ay, az, gx, gy, gz],
      mag: [mx, my, mz],
      rf_fingerprint: "web-sim"
    };
  }

  function startSimulation() {
    if (state.simulating) { return; }
    if (!state.connected) { log("SIMULATE started offline: samples wait for Connect", "warn"); }
    state.simulating = true;
    state.simStep = 0;
    state.simFrameStep = 0;
    state.retryDelay = RETRY_BASE_MS;
    state.backoffUntil = 0;
    setMode("sim");
    log("SIMULATE: deterministic synthetic samples, origin=simulated, rf=web-sim");
    startCaptureLoop();
    startSyntheticCamera();
    updateControls();
  }

  function stopSimulation(silent) {
    if (!state.simulating) { return; }
    state.simulating = false;
    state.localPose = null;
    state.localPoseSamples = 0;
    renderPose(null, "--");
    stopCaptureLoop();
    stopCamera(true);
    if (!silent) { log("SIMULATE stopped"); }
    setMode(state.connected ? "live" : "idle");
    updateControls();
  }

  // --------------------------------------------------------------- capture

  function startCaptureLoop() {
    stopCaptureLoop();
    state.captureTimer = setInterval(captureTick, Math.max(20, Math.round(1000 / readHz())));
  }

  function stopCaptureLoop() {
    if (state.captureTimer) { clearInterval(state.captureTimer); state.captureTimer = null; }
  }

  function captureTick() {
    if (!state.connected) { return; }
    if (Date.now() < state.backoffUntil) { return; }
    var sample = null;
    if (state.simulating) {
      sample = syntheticSample(state.simStep++);
    } else if (state.motionEnabled) {
      sample = measuredSample();
    } else {
      return;
    }
    if (!sample) { return; }
    enqueue(sample);
  }

  function enqueue(sample) {
    state.queue.push(sample);
    state.localPoseSamples += 1;
    var derived = deriveLocalPose(sample);
    if (derived) { state.localPose = derived; }
    if (state.queue.length > MAX_QUEUE) {
      var dropped = state.queue.length - MAX_QUEUE;
      state.queue.splice(0, dropped);
      log("queue overflow: dropped " + dropped + " oldest samples", "warn");
    }
    setText(els.sensorQueue, String(state.queue.length));
    if (state.queue.length >= readBatch()) { flushQueue(); }
  }

  function flushQueue() {
    if (state.sending || !state.connected || !state.queue.length) { return; }
    if (Date.now() < state.backoffUntil) { return; }
    var n = Math.min(readBatch(), state.queue.length, MAX_BATCH);
    var batch = state.queue.slice(0, n);
    state.sending = true;
    request(PATHS.sensorsBatch, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ samples: batch })
    }).then(function (res) {
      state.sending = false;
      if (res.status === 401) { return; }
      if (!res.ok) {
        failBatch(res);
        return;
      }
      state.queue.splice(0, n);
      state.sent += n;
      state.batches += 1;
      state.retryDelay = RETRY_BASE_MS;
      state.backoffUntil = 0;
      clearError();
      setText(els.sensorSamplesSent, String(state.sent));
      setText(els.sensorBatchesSent, String(state.batches));
      setText(els.sensorQueue, String(state.queue.length));
      if (state.batches <= 3 || state.batches % 10 === 0) {
        var accepted = res.body && typeof res.body.accepted === "number" ? res.body.accepted : n;
        var rejected = res.body && typeof res.body.rejected === "number" ? res.body.rejected : 0;
        log("batch " + state.batches + ": accepted " + accepted + ", rejected " + rejected +
          ", queue " + state.queue.length);
      }
      if (state.queue.length >= readBatch()) { flushQueue(); }
    }, function (err) {
      state.sending = false;
      failBatch({ status: 0, error: (err && err.message) || String(err), body: null });
    });
  }

  function failBatch(res) {
    var delay = state.retryDelay;
    state.backoffUntil = Date.now() + delay;
    state.retryDelay = Math.min(RETRY_MAX_MS, Math.round(state.retryDelay * 1.7));
    var message = "sensor batch failed: " + bodyError(res.body, res.error || ("HTTP " + res.status)) +
      " (retry in " + Math.round(delay / 100) / 10 + " s, queue " + state.queue.length + ")";
    noteError(message);
    log(message, "warn");
  }

  // ---------------------------------------------------------------- camera

  function setCameraOverlay(mode, text) {
    if (!els.cameraOverlay) { return; }
    els.cameraOverlay.setAttribute("data-mode", mode);
    els.cameraOverlay.textContent = text || "";
  }

  function startCamera() {
    if (state.simulating) {
      startSyntheticCamera();
      log("SIMULATE owns the camera: synthetic placeholder, no upload");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraOverlay("error", "getUserMedia unavailable");
      state.camera.lastError = "getUserMedia unavailable";
      setText(els.cameraLastError, state.camera.lastError);
      log("camera unavailable: navigator.mediaDevices.getUserMedia missing", "error");
      return;
    }
    setCameraOverlay("warn", "REQUESTING CAMERA");
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    }).then(function (stream) {
      state.camera.stream = stream;
      state.camera.synthetic = false;
      els.cameraVideo.hidden = false;
      if (els.cameraCanvas) { els.cameraCanvas.hidden = true; }
      els.cameraVideo.srcObject = stream;
      var played = els.cameraVideo.play();
      if (played && played.catch) { played.catch(function () {}); }
      setCameraOverlay("live", "");
      state.camera.running = true;
      state.camera.lastError = "";
      setText(els.cameraLastError, "--");
      startCameraTimer();
      updateControls();
      log("camera live: " + readFps() + " fps JPEG to " + PATHS.cameraFrame);
    }).catch(function (err) {
      var name = (err && err.name) || "Error";
      var message = (err && err.message) || String(err);
      var hint = name === "NotAllowedError" ? "permission denied" :
        (name === "NotFoundError" ? "no camera found" :
          (name === "NotReadableError" ? "camera busy" : message));
      state.camera.lastError = name + ": " + hint;
      setCameraOverlay("error", name.toUpperCase());
      setText(els.cameraLastError, state.camera.lastError);
      log("camera failed: " + state.camera.lastError, "error");
      if (window.isSecureContext === false) {
        log("plain http:// is not a secure context; use adb reverse or Termux", "warn");
      }
      updateControls();
    });
  }

  function stopCamera(silent) {
    if (state.camera.timer) { clearInterval(state.camera.timer); state.camera.timer = null; }
    if (state.camera.stream) {
      state.camera.stream.getTracks().forEach(function (track) { track.stop(); });
      state.camera.stream = null;
    }
    if (els.cameraVideo) {
      els.cameraVideo.srcObject = null;
      els.cameraVideo.hidden = true;
    }
    state.camera.running = false;
    state.camera.synthetic = false;
    setCameraOverlay("off", "CAMERA OFF");
    updateControls();
    if (!silent) { log("camera stopped"); }
  }

  function startCameraTimer() {
    if (state.camera.timer) { clearInterval(state.camera.timer); }
    state.camera.timer = setInterval(captureFrame, Math.max(66, Math.round(1000 / readFps())));
  }

  function captureFrame() {
    if (!state.camera.running) { return; }
    if (state.camera.synthetic) {
      drawSyntheticFrame();
      return;
    }
    var video = els.cameraVideo;
    if (!video || !video.videoWidth) { return; }
    var canvas = els.cameraCanvas;
    if (!canvas) { return; }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var ctx = canvas.getContext("2d");
    if (!ctx) { return; }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (typeof canvas.toBlob !== "function") { return; }
    canvas.toBlob(function (blob) {
      if (blob) { postFrame(blob); }
    }, "image/jpeg", 0.82);
  }

  function postFrame(blob) {
    if (!state.connected || state.camera.posting) { return; }
    state.camera.posting = true;
    request(PATHS.cameraFrame, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob
    }).then(function (res) {
      state.camera.posting = false;
      if (res.status === 401) { return; }
      if (!res.ok) {
        state.camera.lastError = "POST " + PATHS.cameraFrame + " HTTP " + res.status;
        setText(els.cameraLastError, state.camera.lastError);
        if (Date.now() - state.camera.lastPostAt > 5000) {
          state.camera.lastPostAt = Date.now();
          log(state.camera.lastError + " " + bodyError(res.body, res.error || ""), "warn");
        }
        return;
      }
      state.camera.frames += 1;
      setText(els.cameraFrames, String(state.camera.frames));
      setText(els.cameraLastError, "--");
      if (state.camera.frames === 1 || state.camera.frames % 30 === 0) {
        log("camera frame " + state.camera.frames + " accepted (" + Math.round(blob.size / 1024) + " KiB)");
      }
    }, function (err) {
      state.camera.posting = false;
      state.camera.lastError = (err && err.message) || String(err);
      setText(els.cameraLastError, state.camera.lastError);
    });
  }

  function startSyntheticCamera() {
    if (state.simulating === false) { return; }
    if (state.camera.stream) {
      state.camera.stream.getTracks().forEach(function (track) { track.stop(); });
      state.camera.stream = null;
    }
    if (els.cameraVideo) { els.cameraVideo.hidden = true; els.cameraVideo.srcObject = null; }
    if (els.cameraCanvas) { els.cameraCanvas.hidden = false; }
    state.camera.synthetic = true;
    state.camera.running = true;
    setCameraOverlay("sim", "");
    drawSyntheticFrame();
    startCameraTimer();
    updateControls();
    setText(els.cameraSimNote, "SIMULATE: deterministic placeholder rendered locally. " +
      "Synthetic frames are NOT uploaded, so a simulated image can never be read as measured.");
  }

  function drawSyntheticFrame() {
    var canvas = els.cameraCanvas;
    if (!canvas) { return; }
    var ctx = canvas.getContext("2d");
    if (!ctx) { return; }
    var w = canvas.width;
    var h = canvas.height;
    var step = state.simFrameStep++;
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(0,255,102,0.18)";
    ctx.lineWidth = 1;
    var x;
    var y;
    for (x = 0; x <= w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (y = 0; y <= h; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    ctx.strokeStyle = "#00FF66";
    ctx.lineWidth = 2;
    ctx.strokeRect(12, 12, w - 24, h - 24);

    var cx = w / 2 + Math.cos(step * 0.08) * (w * 0.22);
    var cy = h / 2 + Math.sin(step * 0.11) * (h * 0.20);
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 30, cy); ctx.lineTo(cx + 30, cy);
    ctx.moveTo(cx, cy - 30); ctx.lineTo(cx, cy + 30);
    ctx.stroke();

    ctx.fillStyle = "rgba(0,255,102,0.10)";
    ctx.fillRect(24, h - 54, w - 48, 30);
    ctx.strokeStyle = "rgba(0,255,102,0.4)";
    ctx.strokeRect(24, h - 54, w - 48, 30);

    ctx.fillStyle = "#00FF66";
    ctx.font = "14px ui-monospace, Consolas, monospace";
    ctx.fillText("ABRASAX // SYNTHETIC CAM", 28, 38);
    ctx.fillStyle = "#7d8a80";
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.fillText("frame " + step + "  ·  not a measured image  ·  no upload", 28, 58);

    var barX = 28;
    for (x = 0; x < 24; x += 1) {
      var bh = 6 + Math.abs(Math.sin((step + x) * 0.4)) * 16;
      ctx.fillStyle = x % 3 === 0 ? "#FFD43B" : "#00FF66";
      ctx.fillRect(barX + x * 8, h - 32 - bh, 5, bh);
    }

    ctx.fillStyle = "rgba(0,255,102,0.06)";
    var scan = (step * 7) % h;
    ctx.fillRect(0, scan, w, 2);

    if (step < 3) {
      log("synthetic camera placeholder active: frames stay local");
    }
  }

  // ------------------------------------------------------------------ wiring

  function clearTimers() {
    stopPolling();
    stopCaptureLoop();
    if (state.camera.timer) { clearInterval(state.camera.timer); state.camera.timer = null; }
  }

  function haltStreams() {
    stopCaptureLoop();
    if (state.camera.timer) { clearInterval(state.camera.timer); state.camera.timer = null; }
    if (state.camera.stream) {
      state.camera.stream.getTracks().forEach(function (track) { track.stop(); });
      state.camera.stream = null;
    }
    state.camera.running = false;
    state.camera.synthetic = false;
    if (els.cameraVideo) { els.cameraVideo.srcObject = null; els.cameraVideo.hidden = true; }
    setCameraOverlay("off", "CAMERA OFF");
    updateControls();
  }

  function bind() {
    els.connectBtn.addEventListener("click", function () { connect(false); });
    els.disconnectBtn.addEventListener("click", disconnect);
    els.pollToggle.addEventListener("change", function () {
      if (els.pollToggle.checked && state.connected) { startPolling(); pollOnce(); }
      else { stopPolling(); }
    });
    els.motionBtn.addEventListener("click", enableMotion);
    els.simulateBtn.addEventListener("click", startSimulation);
    els.stopSimBtn.addEventListener("click", function () { stopSimulation(false); });
    els.cameraStartBtn.addEventListener("click", startCamera);
    els.cameraStopBtn.addEventListener("click", function () { stopCamera(false); });
    els.clearLogBtn.addEventListener("click", function () {
      els.eventLog.textContent = "";
      if (els.logCount) { els.logCount.textContent = "0 lines"; }
    });
    els.cameraFps.addEventListener("change", function () {
      saveInputs();
      if (state.camera.running) { startCameraTimer(); }
    });
    els.captureHz.addEventListener("change", function () {
      saveInputs();
      if (state.captureTimer) { startCaptureLoop(); }
    });
    els.batchSize.addEventListener("change", function () { saveInputs(); });
    els.baseUrl.addEventListener("change", function () { saveInputs(); });
    els.token.addEventListener("change", function () { saveInputs(); });
    window.addEventListener("online", function () { log("network online"); });
    window.addEventListener("offline", function () { log("network offline - samples queue", "warn"); });
  }

  function init() {
    restoreInputs();
    bind();
    updateAvailability();
    updateControls();
    if (els.insecureBanner) {
      els.insecureBanner.hidden = (window.isSecureContext !== false);
    }
    setMode("idle");
    log("ABRASAX world console ready - polling " + POLL_MS + " ms, no websockets");
    var params = new URLSearchParams(window.location.search);
    var baseParam = params.get("base");
    if (baseParam) { els.baseUrl.value = baseParam; }
    if (params.get("connect") !== "0") {
      connect(true);
    }
    if (params.get("simulate") === "1") {
      startSimulation();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
