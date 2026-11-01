/* ABRASAX gateway chat — plain ES2020, no build step, no dependencies.
 *
 * Endpoints (all on the gateway, default http://127.0.0.1:9001):
 *   GET  /health               telemetry, polled every 10 s
 *   GET  /v1/models            model dropdown
 *   POST /v1/chat/completions  OpenAI body shape, stream:false
 *
 * CORS note: gateway 0.4.0 answers OPTIONS with 501 and sends no CORS headers on
 * errors, so an "application/json" POST from another origin (this page is served
 * from :8090) dies in preflight. text/plain is CORS-safelisted, needs no
 * preflight, and the gateway parses the raw body as JSON regardless of
 * Content-Type. Change POST_CONTENT_TYPE to application/json only if you serve
 * this page from the gateway's own origin.
 *
 * Streaming note: gateway 0.4.0 rejects stream:true with HTTP 400
 * ("stream=true is not supported yet; use false"), so replies are non-streaming.
 */
(function () {
  'use strict';

  var DEFAULT_GATEWAY = 'http://127.0.0.1:9001';
  var POST_CONTENT_TYPE = 'text/plain;charset=UTF-8';
  var HEALTH_INTERVAL_MS = 10000;
  var HEALTH_TIMEOUT_MS = 4000;
  var CHAT_TIMEOUT_MS = 180000;
  var MAX_TOKENS = 512;
  var TEMPERATURE = 0.7;
  var HISTORY_LIMIT = 24;

  var params = new URLSearchParams(location.search);
  var GATEWAY = (params.get('gateway') || DEFAULT_GATEWAY).replace(/\/+$/, '');

  var els = {
    route: document.getElementById('route'),
    model: document.getElementById('model'),
    refreshModels: document.getElementById('refreshModels'),
    clearChat: document.getElementById('clearChat'),
    form: document.getElementById('chatForm'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    messages: document.getElementById('messages'),
    intro: document.getElementById('intro'),
    statusLine: document.getElementById('statusLine'),
    gatewayLabel: document.getElementById('gatewayLabel'),
    endpointLabel: document.getElementById('endpointLabel'),
    healthDot: document.getElementById('healthDot'),
    healthStatus: document.getElementById('healthStatus'),
    healthVersion: document.getElementById('healthVersion'),
    healthLatency: document.getElementById('healthLatency'),
    healthChecked: document.getElementById('healthChecked'),
    healthDetail: document.getElementById('healthDetail'),
    offlineBanner: document.getElementById('offlineBanner')
  };

  var history = [];        // [{role:'user'|'assistant', content:string}]
  var busy = false;
  var healthOnline = null; // null unknown, true/false after first probe
  var activeCtrl = null;   // AbortController for the in-flight completion
  var stopRequested = false;

  function setGatewayLabel() {
    els.gatewayLabel.textContent = GATEWAY;
    els.endpointLabel.textContent = GATEWAY;
  }

  function nowLabel() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function setStatus(text, kind) {
    els.statusLine.textContent = text;
    els.statusLine.className = kind || '';
  }

  function scrollIfNearBottom() {
    var box = els.messages;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (near) box.scrollTop = box.scrollHeight;
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function hideIntro() {
    if (els.intro && els.intro.parentNode) els.intro.remove();
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------------- composer state (Operate surface) ---------------- */

  // One place owns the pending look: send yields to stop, the composer stays
  // usable, and a stalled request can always be abandoned with the mouse or Esc.
  function setBusy(on) {
    busy = !!on;
    els.form.classList.toggle('is-busy', busy);
    els.send.disabled = busy;
    els.send.setAttribute('aria-busy', busy ? 'true' : 'false');
    els.stop.disabled = !busy;
  }

  function requestStop() {
    if (!busy || !activeCtrl) return;
    stopRequested = true;
    setStatus('stopping…');
    try { activeCtrl.abort(); } catch (e) { /* already settled */ }
  }

  /* ---------------- transcript ---------------- */

  function addMessage(role, content, meta) {
    hideIntro();
    var wrap = el('div', 'msg ' + role);
    var head = el('div', 'msg-head');
    head.appendChild(el('span', 'msg-role', role === 'user' ? 'you' : role === 'assistant' ? 'abrasax' : 'error'));
    head.appendChild(el('span', 'msg-time', nowLabel()));
    wrap.appendChild(head);

    var body = el('div', 'msg-body');
    body.textContent = content;
    wrap.appendChild(body);

    if (meta && meta.length) {
      var metaRow = el('div', 'msg-meta');
      meta.forEach(function (m) {
        var span = el('span', m.bad ? 'bad' : '', m.text);
        if (m.title) span.title = m.title;
        metaRow.appendChild(span);
      });
      wrap.appendChild(metaRow);
    }

    els.messages.appendChild(wrap);
    scrollToBottom();
    return { wrap: wrap, body: body };
  }

  function addPending() {
    hideIntro();
    var wrap = el('div', 'msg assistant pending');
    var head = el('div', 'msg-head');
    head.appendChild(el('span', 'msg-role', 'abrasax'));
    head.appendChild(el('span', 'msg-time', nowLabel()));
    wrap.appendChild(head);
    var body = el('div', 'msg-body');
    var typing = el('span', 'typing');
    typing.appendChild(el('i'));
    typing.appendChild(el('i'));
    typing.appendChild(el('i'));
    body.appendChild(typing);
    body.appendChild(el('span', '', ' thinking…'));
    wrap.appendChild(body);
    els.messages.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  // Neutral, non-red line for things the user did (stopped a request).
  function addNotice(text) {
    var m = addMessage('notice', text);
    m.wrap.querySelector('.msg-head').remove();
    return m;
  }

  // The bubble states the real HTTP status; the detail line is the body text.
  function addError(detail, meta, status) {
    var m = addMessage('error', detail, meta || []);
    if (status) {
      var chip = el('span', 'msg-status', 'HTTP ' + status);
      chip.title = 'HTTP status returned by the gateway';
      m.wrap.querySelector('.msg-head').appendChild(chip);
    }
    return m;
  }

  /* ---------------- models ---------------- */

  var MODELS = [];        // flattened [{id, provider}] from /v1/models
  var modelsLoaded = false;

  function providerOf(entry) {
    var owner = String(entry.owned_by || '');
    var idx = owner.indexOf('/');
    return idx >= 0 ? owner.slice(idx + 1) : owner || 'other';
  }

  function resetModelSelect(label, disabled) {
    els.model.innerHTML = '';
    var opt = el('option', '', label);
    opt.value = '';
    opt.disabled = true;
    opt.selected = true;
    els.model.appendChild(opt);
    els.model.disabled = !!disabled;
  }

  // The gateway ignores a bare model id — abrasax/gateway.py:79-85 reads only a
  // "<provider>:<id>" prefix to pin a model. So the dropdown is scoped to the pinned
  // route and requests send "<route>:<id>". Route "auto" sends no model at all and
  // lets the router use each provider's default in lmstudio → nvidia → xpl order.
  function renderModels() {
    if (!modelsLoaded) return;
    var route = els.route.value;

    if (route === 'auto') {
      els.model.innerHTML = '';
      var autoOpt = el('option', '', 'gateway default (auto)');
      autoOpt.value = '';
      els.model.appendChild(autoOpt);
      els.model.disabled = true;
      return;
    }

    var list = MODELS.filter(function (m) { return m.provider === route; });
    if (!list.length) {
      resetModelSelect('no ' + route + ' models advertised', true);
      return;
    }

    var remembered = null;
    try { remembered = localStorage.getItem('abrasax-ui.model.' + route); } catch (e) { /* ignore */ }
    els.model.innerHTML = '';
    var pick = null;
    list.forEach(function (m) {
      var opt = el('option', '', m.id);
      opt.value = m.id;
      opt.dataset.provider = m.provider;
      els.model.appendChild(opt);
      if (m.id === remembered) pick = m.id;
    });
    els.model.disabled = false;
    els.model.value = pick || list[0].id;
  }

  function loadModels() {
    modelsLoaded = false;
    resetModelSelect('loading models…', true);
    setStatus('loading models…');

    return fetch(GATEWAY + '/v1/models', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var rows = Array.isArray(data && data.data) ? data.data : [];
        var seen = Object.create(null);
        var skipped = 0;

        MODELS = [];
        rows.forEach(function (row) {
          var id = row && row.id;
          if (typeof id !== 'string') { skipped += 1; return; } // e.g. xpl's "uncensored": true
          if (!id.trim() || seen[id]) return;
          seen[id] = true;
          MODELS.push({ id: id, provider: providerOf(row) });
        });

        modelsLoaded = true;
        if (!MODELS.length) {
          resetModelSelect('no models advertised by gateway', true);
          setStatus('gateway advertised 0 models', 'bad');
          return;
        }

        renderModels();
        setStatus(MODELS.length + ' models · ' +
          (skipped ? skipped + ' malformed entr' + (skipped === 1 ? 'y' : 'ies') + ' skipped' : 'all entries valid'), 'ok');
      })
      .catch(function (err) {
        MODELS = [];
        modelsLoaded = false;
        var why = err && err.message === 'Failed to fetch' ? 'gateway offline' : (err && err.message) || 'gateway offline';
        resetModelSelect('models unavailable — ' + why, false);
        setStatus('model list failed: ' + why, 'bad');
      });
  }

  /* ---------------- health ---------------- */

  function pollHealth() {
    var started = performance.now();
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, HEALTH_TIMEOUT_MS);

    if (healthOnline === null) {
      els.healthDot.className = 'dot checking';
      els.healthStatus.textContent = 'checking gateway…';
    }

    return fetch(GATEWAY + '/health', { cache: 'no-store', signal: ctrl.signal })
      .then(function (res) {
        var latency = Math.round(performance.now() - started);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json().then(function (data) { return { data: data, latency: latency }; });
      })
      .then(function (out) {
        healthOnline = true;
        els.healthDot.className = 'dot ok';
        els.healthStatus.textContent = 'online';
        els.healthVersion.textContent = 'v' + (out.data.version || '?') + (out.data.service ? ' · ' + out.data.service : '');
        els.healthLatency.textContent = out.latency + ' ms';
        els.healthChecked.textContent = 'last check ' + nowLabel();
        els.healthDetail.textContent = '';
        els.offlineBanner.hidden = true;
        document.body.classList.remove('is-offline');
      })
      .catch(function (err) {
        healthOnline = false;
        var why = err && err.name === 'AbortError' ? 'timeout after ' + (HEALTH_TIMEOUT_MS / 1000) + ' s' : (err && err.message) || 'unreachable';
        els.healthDot.className = 'dot bad';
        els.healthStatus.textContent = 'gateway offline';
        els.healthVersion.textContent = 'version —';
        els.healthLatency.textContent = '—';
        els.healthChecked.textContent = 'last check ' + nowLabel();
        els.healthDetail.textContent = why + ' @ ' + GATEWAY;
        els.offlineBanner.hidden = false;
        document.body.classList.add('is-offline');
        // The composer is deliberately left enabled: the gateway may come back
        // inside the 10 s retry window and a queued message should still go out.
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* ---------------- chat ---------------- */

  function readReply(data) {
    var choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    var msg = choice && choice.message ? choice.message : null;
    var content = msg && typeof msg.content === 'string' ? msg.content : '';
    var reasoning = msg && typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
    return { content: content, reasoning: reasoning, choice: choice };
  }

  function extractError(status, raw) {
    try {
      var data = JSON.parse(raw);
      if (data && data.error) {
        if (typeof data.error === 'string') return data.error;
        if (data.error.message) return data.error.message;
      }
      if (data && data.message) return String(data.message);
    } catch (e) { /* not JSON */ }
    var text = String(raw || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 300) : 'empty response body';
  }

  function sendMessage(text) {
    if (busy) return;
    var message = String(text || '').trim();
    if (!message) return;

    els.input.value = '';
    resizeInput();
    hideIntro();
    addMessage('user', message);
    history.push({ role: 'user', content: message });

    setBusy(true);
    setStatus('waiting for gateway…');
    var pending = addPending();

    var outbound = history.slice(-HISTORY_LIMIT);
    var route = els.route.value;
    var body = {
      messages: outbound,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      stream: false,
      abrasax: { route: route }
    };
    // Prefix required by the gateway (gateway.py:79-85); a bare id would be ignored.
    if (route !== 'auto' && els.model.value) body.model = route + ':' + els.model.value;

    var started = performance.now();
    var ctrl = new AbortController();
    activeCtrl = ctrl;
    var timer = setTimeout(function () { ctrl.abort(); }, CHAT_TIMEOUT_MS);

    fetch(GATEWAY + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': POST_CONTENT_TYPE },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
      .then(function (res) {
        return res.text().then(function (raw) {
          return { res: res, raw: raw, roundtrip: Math.round(performance.now() - started) };
        });
      })
      .then(function (out) {
        if (!out.res.ok) {
          var detail = extractError(out.res.status, out.raw);
          throw Object.assign(new Error(detail), { status: out.res.status, raw: out.raw });
        }
        var data;
        try { data = JSON.parse(out.raw); } catch (e) {
          throw Object.assign(new Error('gateway returned non-JSON: ' + out.raw.slice(0, 200)), { status: out.res.status });
        }
        var reply = readReply(data);
        var content = reply.content || reply.reasoning;
        if (!content) {
          throw Object.assign(new Error('empty reply from gateway (no choices[0].message.content)'), { status: out.res.status });
        }

        pending.remove();
        var meta = [];
        if (data.model) meta.push({ text: String(data.model) });
        var via = data.abrasax && data.abrasax.routed_via;
        if (via) meta.push({ text: 'via ' + via });
        if (data.usage && data.usage.total_tokens) meta.push({ text: data.usage.total_tokens + ' tokens' });
        meta.push({ text: out.roundtrip + ' ms' });

        var bubble = addMessage('assistant', content, meta);
        if (reply.reasoning && reply.reasoning !== content) {
          var det = el('details');
          det.appendChild(el('summary', '', 'reasoning_content'));
          det.appendChild(el('div', '', reply.reasoning));
          bubble.wrap.appendChild(det);
        }
        scrollIfNearBottom();

        history.push({ role: 'assistant', content: content });
        if (history.length > 80) history = history.slice(-80);
        setStatus('reply received in ' + out.roundtrip + ' ms', 'ok');
      })
      .catch(function (err) {
        pending.remove();

        if (stopRequested) {
          addNotice('stopped — request aborted after ' + Math.round(performance.now() - started) + ' ms');
          setStatus('stopped by you');
          return;
        }

        var heading;
        var status = err && err.status;
        if (status) {
          heading = err.message;
        } else if (err && err.name === 'AbortError') {
          heading = 'gateway timeout after ' + (CHAT_TIMEOUT_MS / 1000) + ' s — ' + GATEWAY;
        } else {
          heading = 'gateway offline — ' + (err && err.message ? err.message : 'fetch failed') +
            ' (' + GATEWAY + '). Is the gateway running?';
        }
        var meta = [{ text: 'POST /v1/chat/completions', bad: true }];
        addError(heading, meta, status);
        var verdict;
        if (status) verdict = 'send failed — HTTP ' + status;
        else if (err && err.name === 'AbortError') verdict = 'send failed — gateway timeout';
        else verdict = 'send failed — gateway offline';
        setStatus(verdict, 'bad');
        // Keep the user turn in history so a retry carries full context.
      })
      .finally(function () {
        clearTimeout(timer);
        activeCtrl = null;
        stopRequested = false;
        setBusy(false);
        els.input.focus();
      });
  }

  /* ---------------- input chrome ---------------- */

  function resizeInput() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 180) + 'px';
  }

  els.form.addEventListener('submit', function (event) {
    event.preventDefault();
    sendMessage(els.input.value);
  });

  els.input.addEventListener('input', resizeInput);
  els.input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage(els.input.value);
    }
  });
  els.input.addEventListener('paste', function () { setTimeout(resizeInput, 0); });

  els.stop.addEventListener('click', requestStop);

  // Esc abandons the in-flight completion without touching the typed text.
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && busy) {
      event.preventDefault();
      requestStop();
    }
  });

  els.route.addEventListener('change', function () {
    try { localStorage.setItem('abrasax-ui.route', els.route.value); } catch (e) { /* ignore */ }
    renderModels();
    var route = els.route.value;
    if (route === 'auto') {
      setStatus('route auto — gateway picks provider defaults (lmstudio → nvidia → xpl)');
    } else if (!modelsLoaded) {
      setStatus('route ' + route + ' — models not loaded (click ↻ to retry)');
    } else if (!els.model.value) {
      setStatus('route ' + route + ' — no matching model advertised; gateway default will be used', 'bad');
    } else {
      setStatus('route ' + route + ' — model ' + els.model.value);
    }
  });

  els.model.addEventListener('change', function () {
    var route = els.route.value;
    if (route === 'auto' || !els.model.value) return;
    try { localStorage.setItem('abrasax-ui.model.' + route, els.model.value); } catch (e) { /* ignore */ }
    setStatus('model ' + els.model.value + ' · route ' + route + ' (sent as ' + route + ':' + els.model.value + ')');
  });

  els.refreshModels.addEventListener('click', loadModels);

  els.clearChat.addEventListener('click', function () {
    if (busy) return;
    if (history.length && !window.confirm('Clear this conversation?')) return;
    history = [];
    Array.prototype.slice.call(els.messages.querySelectorAll('.msg')).forEach(function (n) { n.remove(); });
    if (els.intro) els.messages.appendChild(els.intro);
    setStatus('conversation cleared');
    els.input.focus();
  });

  /* ---------------- init ---------------- */

  setGatewayLabel();
  setBusy(false);
  // ?gateway=... is per-load only (and used by the offline smoke test); not persisted,
  // so pointing one tab at a dead port cannot break the saved gateway for every tab.

  var savedRoute = null;
  try { savedRoute = localStorage.getItem('abrasax-ui.route'); } catch (e) { /* ignore */ }
  if (savedRoute && ['auto', 'lmstudio', 'nvidia', 'xpl'].indexOf(savedRoute) >= 0) {
    els.route.value = savedRoute; // applied once loadModels() can match a provider
  }

  resetModelSelect('loading models…', true);
  resizeInput();
  loadModels();
  pollHealth();
  setInterval(pollHealth, HEALTH_INTERVAL_MS);

  // Composer is the Operate affordance — focus it on load unless the user
  // arrived via a hash link to something else.
  if (!location.hash) {
    try { els.input.focus({ preventScroll: true }); } catch (e) { els.input.focus(); }
  }

  // Expose a tiny debug handle for smoke tests (no framework needed).
  window.AbrasaXUI = {
    gateway: GATEWAY,
    send: sendMessage,
    stop: requestStop,
    refreshModels: loadModels,
    pollHealth: pollHealth,
    busy: function () { return busy; },
    history: function () { return history.slice(); }
  };
})();
