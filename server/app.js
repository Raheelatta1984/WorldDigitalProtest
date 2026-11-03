import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import config from './config.js';
import apiRouter from './routes/api.js';
import * as store from './lib/store.js';
import * as events from './lib/events.js';
import { PROTOCOL, PROTOCOL_HASH, ProtocolError } from './lib/protocol.js';
import { geodbStats } from './lib/geo.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

store.loadDb();
store.rebuildAllStats();

const summaryFor = (protestId) => {
  const protest = store.getProtest(protestId);
  if (!protest) return null;
  const kpi = store.buildKpi(protestId);
  return {
    id: protest.id,
    headline: protest.headline,
    phase: store.protestPhase(protest),
    total: kpi.total,
    real: kpi.real,
    injected: kpi.injected,
    target: protest.targetJoiners,
    progress: kpi.progress,
    countryCount: kpi.countryCount,
    cityCount: kpi.cityCount,
    startsAt: protest.startsAt,
    endsAt: protest.endsAt,
    youtube: protest.youtube,
  };
};

const snapshotFor = (protestId) => {
  // Everything required to render a full dashboard for a late subscriber.
  const kpi = store.buildKpi(protestId);
  const protest = store.getProtest(protestId);
  if (!kpi || !protest) return null;
  return {
    headline: protest.headline,
    reason: protest.reason,
    phase: store.protestPhase(protest),
    targets: protest.targetJoiners,
    kpi,
  };
};

events.attachProviders({
  kpi: (id) => store.buildKpi(id),
  summary: summaryFor,
  snapshot: snapshotFor,
});

// ---------------------------------------------------------------------------
// Headers: keep the app embeddable in previews/iframes and CORS-open for beacons
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Injection-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Explicitly allow embedding (stream overlays, dashboards, kiosk screens).
  res.removeHeader('X-Frame-Options');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// Small request log for local development; silent in test runs.
if (!process.env.WDP_SILENT) {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api') && req.path !== '/api/status') {
        console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
      }
    });
    next();
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/healthz', (req, res) =>
  res.json({
    ok: true,
    protocol: PROTOCOL.version,
    protocolHash: PROTOCOL_HASH,
    protests: Object.keys(store.getDb().protests).length,
    geo: geodbStats(),
    uptimeSeconds: Math.round(process.uptime()),
  })
);

app.use('/api', apiRouter);

// A tiny status endpoint the homepage uses before the API is hit.
app.get('/api', (req, res) =>
  res.json({ ok: true, name: 'World Digital Protest API', protocol: PROTOCOL_HASH })
);

// ---------------------------------------------------------------------------
// Static app
// ---------------------------------------------------------------------------

const cacheable = (file) => /\.(?:js|css|json|svg|png|jpg|webp|woff2?)$/.test(file);

app.use(
  express.static(config.publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (cacheable(filePath)) res.setHeader('Cache-Control', 'public, max-age=300');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Convenience aliases so shared links can be short.
app.get('/p/:id', (req, res) => res.redirect(`/protest.html?id=${encodeURIComponent(req.params.id)}`));
app.get('/live/:id', (req, res) => res.sendFile(path.join(config.publicDir, 'live.html')));
app.get('/overlay/:id', (req, res) => res.sendFile(path.join(config.publicDir, 'overlay.html')));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Endpoint not found.' });
  }
  if (req.method === 'GET' && req.accepts('html')) {
    const notFound = path.join(config.publicDir, '404.html');
    if (fs.existsSync(notFound)) return res.status(404).sendFile(notFound);
  }
  return next();
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ProtocolError || err.code === 'consent_required') {
    return res.status(err.status || 400).json({
      ok: false,
      error: err.message,
      code: err.code,
      details: err.details || {},
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Request body was not valid JSON.' });
  }
  console.error('Unhandled error:', err);
  return res.status(err.status || 500).json({
    ok: false,
    error: err.status ? err.message : 'Something went wrong on the server.',
  });
});


export default app;
