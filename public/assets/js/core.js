/* global window, document, EventSource, fetch */
/**
 * Shared browser core: tiny helpers, API client, live stream client and the
 * live KPI map renderer. No build step, no framework, no third-party scripts.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
  const compact = (n) => {
    const num = Number(n || 0);
    if (num < 1000) return String(num);
    if (num < 1e6) return `${(num / 1000).toFixed(num < 1e4 ? 1 : 0)}k`;
    return `${(num / 1e6).toFixed(num < 1e7 ? 2 : 1)}M`;
  };
  const pct = (n) => `${Number(n || 0).toFixed(1)}%`;
  const escapeHtml = (str) =>
    String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);

  const timeAgo = (iso) => {
    const diff = Date.now() - Date.parse(iso);
    if (!Number.isFinite(diff)) return '—';
    const s = Math.max(0, Math.round(diff / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };

  const formatDateTime = (iso) =>
    iso
      ? new Date(iso).toLocaleString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const relativeToNow = (iso) => {
    const delta = Date.parse(iso) - Date.now();
    const abs = Math.abs(delta);
    const mins = Math.round(abs / 60000);
    const hours = Math.round(abs / 3600000);
    const days = Math.round(abs / 86400000);
    let text;
    if (mins < 60) text = `${mins} min`;
    else if (hours < 48) text = `${hours} hr`;
    else text = `${days} days`;
    return delta >= 0 ? `in ${text}` : `${text} ago`;
  };

  const debounce = (fn, wait) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  };

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // -------------------------------------------------------------- api client
  async function request(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`/api${path}`, opts);
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { ok: false, error: 'Server returned an unreadable response.' };
    }
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      err.details = data.details;
      throw err;
    }
    return data;
  }

  const api = {
    protocol: () => request('/protocol'),
    screen: (body) => request('/protocol/screen', { method: 'POST', body }),
    status: () => request('/status'),
    geoStats: () => request('/geo/stats'),
    resolve: (lat, lng) => request('/geo/resolve', { method: 'POST', body: { lat, lng } }),
    countries: (q) => request(`/geo/countries${q ? `?q=${encodeURIComponent(q)}&limit=40` : ''}`),
    countryDetail: (code) => request(`/geo/countries/${encodeURIComponent(code)}`),
    cities: (q, country) =>
      request(
        `/geo/cities?q=${encodeURIComponent(q || '')}${
          country ? `&country=${encodeURIComponent(country)}` : ''
        }&limit=40`
      ),
    protests: (includeEnded) => request(`/protests${includeEnded === false ? '?includeEnded=false' : ''}`),
    protest: (id) => request(`/protests/${encodeURIComponent(id)}`),
    kpi: (id) => request(`/protests/${encodeURIComponent(id)}/kpi`),
    joiners: (id, limit) =>
      request(`/protests/${encodeURIComponent(id)}/joiners?limit=${limit || 40}`),
    createProtest: (body) => request('/protests', { method: 'POST', body }),
    updateProtest: (id, body) => request(`/protests/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    endProtest: (id) => request(`/protests/${encodeURIComponent(id)}/end`, { method: 'POST' }),
    deleteProtest: (id) => request(`/protests/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    join: (id, body) => request(`/protests/${encodeURIComponent(id)}/join`, { method: 'POST', body }),
    beacon: (id) => request(`/protests/${encodeURIComponent(id)}/beacon`),
    inspect: (code) => request('/join/inspect', { method: 'POST', body: { code } }),
    joinOffline: (body) => request('/join/offline', { method: 'POST', body }),
    envelope: (pairingCode) =>
      request('/join/offline/envelope', { method: 'POST', body: { pairingCode } }),
    syncOffline: (items) => request('/join/offline/sync', { method: 'POST', body: { items } }),
    report: (id, body) => request(`/protests/${encodeURIComponent(id)}/report`, { method: 'POST', body }),
    reportList: () => request('/reports'),
    physicalRequests: (id) => request(`/protests/${encodeURIComponent(id)}/physical-requests`),
    physicalRequest: (id, body) =>
      request(`/protests/${encodeURIComponent(id)}/physical-request`, { method: 'POST', body }),
    inject: (id, body) => request(`/test/inject/${encodeURIComponent(id)}`, { method: 'POST', body }),
    injectWorldwide: (id, body) =>
      request(`/test/inject/${encodeURIComponent(id)}/worldwide`, { method: 'POST', body }),
    clearInjections: (id) =>
      request(`/test/inject/${encodeURIComponent(id)}/clear`, { method: 'POST' }),
    audit: () => request('/audit'),
  };

  // ------------------------------------------------------------- live stream
  /**
   * Reconnecting live client. Uses SSE when available and falls back to polling
   * so a dashboard keeps counting even behind a proxy that buffers streams.
   */
  function live(protestId, handlers) {
    const h = handlers || {};
    let source = null;
    let pollTimer = null;
    let closed = false;
    let lastTotal = null;

    const emit = (name, payload) => {
      if (typeof h[name] === 'function') {
        try {
          h[name](payload);
        } catch (err) {
          console.error(`live handler "${name}" failed`, err);
        }
      }
    };

    const startPolling = () => {
      if (pollTimer || closed) return;
      const tick = async () => {
        if (closed) return;
        try {
          const { kpi } = await api.kpi(protestId);
          emit('kpi', { protestId, kpi });
        } catch (err) {
          emit('error', err);
        }
      };
      tick();
      pollTimer = setInterval(tick, 3000);
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const connect = () => {
      if (closed) return;
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      source = new EventSource(`/api/protests/${encodeURIComponent(protestId)}/stream`);

      source.addEventListener('snapshot', (ev) => {
        const data = JSON.parse(ev.data);
        emit('snapshot', data);
        emit('kpi', data);
      });
      source.addEventListener('kpi', (ev) => emit('kpi', JSON.parse(ev.data)));
      source.addEventListener('join', (ev) => {
        const data = JSON.parse(ev.data);
        emit('join', data);
        if (lastTotal !== null && data.total > lastTotal) emit('growth', data.total - lastTotal);
        lastTotal = data.total;
      });
      source.addEventListener('ended', (ev) => emit('ended', JSON.parse(ev.data)));
      source.addEventListener('hello', () => {
        stopPolling();
        emit('connected', {});
      });
      source.onopen = () => {
        stopPolling();
        emit('connected', {});
      };
      source.onerror = () => {
        emit('disconnected', {});
        // EventSource retries by itself; keep a polling fallback in parallel so
        // numbers never freeze on a buffering proxy.
        startPolling();
      };
    };

    connect();

    return {
      close() {
        closed = true;
        stopPolling();
        if (source) source.close();
      },
    };
  }

  // ------------------------------------------------------------------- map
  /**
   * Equirectangular live map: world polygons from Natural Earth (shipped as a
   * static JSON file) with one bubble per country scaled by participant count.
   */
  function createMap(canvas, options) {
    const opts = Object.assign({ color: '#2ee6a8', onCountryClick: null }, options || {});
    const ctx = canvas.getContext('2d');
    let world = null;
    let points = [];
    let hover = null;
    let dpr = 1;
    // The basemap is cropped to the inhabited latitudes; bubbles use the same band.
    let latMax = 84;
    let latMin = -58;

    const project = (lng, lat, w, hgt) => [
      ((lng + 180) / 360) * w,
      ((latMax - Math.max(latMin, Math.min(latMax, lat))) / (latMax - latMin)) * hgt,
    ];

    const aspect = () => (latMax - latMin) / 360;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      const height = Math.round(rect.width * aspect());
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.height = `${height}px`;
      draw();
    }

    function drawLand() {
      const w = canvas.width;
      const hgt = canvas.height;
      ctx.save();
      ctx.lineWidth = Math.max(0.6, dpr * 0.5);
      for (const poly of world.polygons) {
        const ring = poly.rings[0];
        if (!ring || ring.length < 3) continue;
        ctx.beginPath();
        for (let i = 0; i < ring.length; i += 1) {
          const [x, y] = project(ring[i][0], ring[i][1], w, hgt);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(38, 55, 84, 0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(88, 116, 158, 0.45)';
        ctx.stroke();
      }
      ctx.restore();
    }

    function draw() {
      const w = canvas.width;
      const hgt = canvas.height;
      ctx.clearRect(0, 0, w, hgt);
      if (!world) return;
      drawLand();

      const max = points.reduce((m, p) => Math.max(m, p.count), 0) || 1;
      const sorted = [...points].sort((a, b) => b.count - a.count);
      sorted.forEach((p, index) => {
        const [x, y] = project(p.lng, p.lat, w, hgt);
        const scale = Math.sqrt(p.count / max);
        const radius = (2.5 + scale * 18) * dpr * (hgt / (620 * dpr));
        const isHover = hover && hover.code === p.code;
        const alpha = 0.18 + 0.5 * scale;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
        grad.addColorStop(0, hexA(opts.color, Math.min(0.85, alpha + 0.25)));
        grad.addColorStop(1, hexA(opts.color, 0));
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.6 * dpr, radius * 0.16), 0, Math.PI * 2);
        ctx.fillStyle = isHover ? '#ffffff' : opts.color;
        ctx.fill();

        // Label the twelve biggest bubbles so the map reads without interaction.
        if (index < 12 || isHover) {
          ctx.font = `${Math.round(11 * dpr)}px -apple-system, Segoe UI, sans-serif`;
          ctx.fillStyle = isHover ? '#ffffff' : 'rgba(238, 243, 251, 0.92)';
          ctx.textAlign = 'center';
          const label = `${p.name} ${compactLabel(p.count)}`;
          ctx.fillText(label, x, y - radius - 5 * dpr);
        }
      });
    }

    const compactLabel = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

    const hexA = (hex, alpha) => {
      const clean = hex.replace('#', '');
      const num = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    function hitTest(evt) {
      if (!points.length || !world) return null;
      const rect = canvas.getBoundingClientRect();
      const x = ((evt.clientX - rect.left) / rect.width) * canvas.width;
      const y = ((evt.clientY - rect.top) / rect.height) * canvas.height;
      let best = null;
      let bestDist = Infinity;
      for (const p of points) {
        const [px, py] = project(p.lng, p.lat, canvas.width, canvas.height);
        const d = Math.hypot(px - x, py - y);
        if (d < Math.max(22 * dpr, bestDist) && d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      return bestDist < 40 * dpr ? best : null;
    }

    canvas.addEventListener('mousemove', (evt) => {
      const next = hitTest(evt);
      const changed = (next && next.code) !== (hover && hover.code);
      hover = next;
      canvas.style.cursor = next ? 'pointer' : 'default';
      if (changed) draw();
    });
    canvas.addEventListener('mouseleave', () => {
      hover = null;
      draw();
    });
    canvas.addEventListener('click', (evt) => {
      const hit = hitTest(evt);
      if (hit && typeof opts.onCountryClick === 'function') opts.onCountryClick(hit);
    });
    const onResize = debounce(resize, 150);
    window.addEventListener('resize', onResize);

    const ready = fetch('/assets/data/world.map.json')
      .then((r) => r.json())
      .then((json) => {
        world = json;
        if (Number.isFinite(json.latMax)) latMax = json.latMax;
        if (Number.isFinite(json.latMin)) latMin = json.latMin;
        resize();
        return json;
      });

    return {
      ready,
      setPoints(next) {
        points = Array.isArray(next) ? next.filter((p) => p.lat && p.lng) : [];
        draw();
      },
      destroy() {
        window.removeEventListener('resize', onResize);
      },
    };
  }

  // --------------------------------------------------------------- storage
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode: carry on without persistence */
      }
    },
    del(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  /** Stable anonymous device credential: random, never derived from anything personal. */
  function deviceSeed() {
    const key = 'wdp.device';
    let seed = store.get(key, null);
    if (!seed) {
      const bytes = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      seed = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      store.set(key, seed);
    }
    return seed;
  }

  // ------------------------------------------------------------------ toast
  function toast(message, kind) {
    let host = $('#toast-host');
    if (!host) {
      host = el('div', {
        id: 'toast-host',
        style:
          'position:fixed;right:16px;bottom:16px;z-index:9999;display:grid;gap:8px;max-width:min(360px,90vw)',
      });
      document.body.append(host);
    }
    const node = el('div', { class: `notice ${kind || 'info'}` }, message);
    node.style.boxShadow = '0 18px 50px rgba(0,0,0,.5)';
    host.append(node);
    setTimeout(() => {
      node.style.transition = 'opacity .3s ease';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 320);
    }, 4200);
  }

  // ------------------------------------------------------------- nav helper
  function markNav() {
    const page = location.pathname.split('/').pop() || 'index.html';
    $$('.nav a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href === page || (page === 'index.html' && href === '/')) a.setAttribute('aria-current', 'page');
    });
  }

  /** Fetch the protocol once per page and cache it. */
  let protocolPromise = null;
  function getProtocol() {
    if (!protocolPromise) protocolPromise = api.protocol().then((d) => d.protocol);
    return protocolPromise;
  }

  function genderLabel(key) {
    return (
      {
        female: 'Female',
        male: 'Male',
        'non-binary': 'Non-binary',
        undisclosed: 'Prefer not to say',
      }[key] || key
    );
  }

  function channelLabel(key) {
    return (
      {
        web: 'Internet',
        'internet-link': 'Shared link',
        bluetooth: 'Bluetooth',
        'wifi-hotspot': 'Nearby Wi-Fi',
        'beacon-qr': 'Scanned code',
        'offline-queue': 'Offline queued',
      }[key] || key
    );
  }

  document.addEventListener('DOMContentLoaded', markNav);

  window.WDP = {
    $,
    $$,
    el,
    fmt,
    compact,
    pct,
    timeAgo,
    formatDateTime,
    relativeToNow,
    escapeHtml,
    debounce,
    clamp,
    api,
    live,
    createMap,
    store,
    deviceSeed,
    toast,
    getProtocol,
    genderLabel,
    channelLabel,
  };
})();
