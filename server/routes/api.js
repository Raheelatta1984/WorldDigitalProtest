import express from 'express';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import config from '../config.js';
import {
  PROTOCOL,
  PROTOCOL_HASH,
  ProtocolError,
  ageToBand,
  normalizeConsent,
  normalizeGender,
  validateProtocolVersion,
  assertPeacefulLanguage,
  buildBeacon,
  encodeBeacon,
  decodeBeacon,
  signEnvelope,
  verifyEnvelope,
  screenText,
} from '../lib/protocol.js';
import {
  listCountries,
  getCountry,
  searchCountries,
  searchCities,
  listRegions,
  listCitiesInCountry,
  resolveLocation,
  geodbStats,
} from '../lib/geo.js';
import * as store from '../lib/store.js';
import * as events from '../lib/events.js';
import { injectParticipants, injectWorldwide, injectionMeta } from '../lib/injector.js';

const router = express.Router();

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, ...data });

const offlineSecret = (pairingCode) =>
  crypto.createHash('sha256').update(`wdp:${pairingCode}:${PROTOCOL_HASH}`).digest('hex');

const requireInjection = (req, res, next) => {
  if (!config.enableTestInjection) {
    return res.status(403).json({ ok: false, error: 'Test injection is disabled on this deployment.' });
  }
  if (config.injectionToken && req.get('x-injection-token') !== config.injectionToken) {
    return res.status(403).json({ ok: false, error: 'Injection token required.' });
  }
  return next();
};

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

router.get('/protocol', (req, res) => {
  ok(res, { protocol: PROTOCOL, hash: PROTOCOL_HASH });
});

router.post('/protocol/screen', (req, res) => {
  const result = screenText(req.body?.headline, req.body?.reason, req.body?.asks);
  ok(res, { result });
});

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

router.get('/geo/stats', (req, res) => ok(res, { stats: geodbStats() }));

router.get('/geo/countries', (req, res) => {
  const q = req.query.q ? String(req.query.q) : '';
  const limit = Math.min(400, Number(req.query.limit) || 30);
  ok(res, { countries: q ? searchCountries(q, limit) : listCountries() });
});

router.get('/geo/countries/:code', (req, res) => {
  const country = getCountry(req.params.code);
  if (!country) return res.status(404).json({ ok: false, error: 'Unknown country.' });
  return ok(res, {
    country,
    regions: listRegions(country.iso2),
    cities: listCitiesInCountry(country.iso2, { limit: 80 }),
  });
});

/**
 * Resolve an approximate coordinate to a country / region / city without
 * joining and without storing the coordinate. The browser rounds the position
 * before sending it, and the server returns only the containing area.
 */
router.post('/geo/resolve', (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: 'Two numbers (lat, lng) are required.' });
  }
  const resolved = resolveLocation({ lat, lng });
  const country = getCountry(resolved.country);
  return ok(res, { location: resolved, country });
});

router.get('/geo/cities', (req, res) => {
  const query = String(req.query.q || '');
  const country = req.query.country ? String(req.query.country) : undefined;
  const limit = Math.min(100, Number(req.query.limit) || 25);
  return ok(res, { cities: searchCities(query, { country, limit }) });
});

// ---------------------------------------------------------------------------
// Protests
// ---------------------------------------------------------------------------

function summary(protestId) {
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
    countries: kpi.countryCount,
    cities: kpi.cityCount,
    startsAt: protest.startsAt,
    endsAt: protest.endsAt,
  };
}

router.get('/protests', (req, res) => {
  const includeEnded = req.query.includeEnded !== 'false';
  ok(res, { protests: store.listProtests({ includeEnded }) });
});

router.post('/protests', (req, res) => {
  const body = req.body || {};
  const protest = store.createProtest({ ...body, protocolHash: PROTOCOL_HASH });
  protest.protocolHash = PROTOCOL_HASH;
  store.scheduleSave();
  events.markDirty(protest.id);
  return ok(res, { protest: store.serializeProtest(protest, { withKpi: true }) }, 201);
});

router.get('/protests/:id', (req, res) => {
  const protest = store.getProtest(req.params.id);
  if (!protest) return res.status(404).json({ ok: false, error: 'Protest not found.' });
  return ok(res, { protest: store.serializeProtest(protest, { withKpi: true }) });
});

router.patch('/protests/:id', (req, res) => {
  const protest = store.updateProtest(req.params.id, req.body || {});
  events.markDirty(protest.id);
  return ok(res, { protest: store.serializeProtest(protest, { withKpi: true }) });
});

router.post('/protests/:id/end', (req, res) => {
  const protest = store.endProtest(req.params.id);
  events.markDirty(protest.id);
  events.publish(protest.id, 'ended', { protestId: protest.id, at: protest.endedAt });
  return ok(res, { protest: store.serializeProtest(protest, { withKpi: true }) });
});

router.delete('/protests/:id', (req, res) => {
  const protest = store.deleteProtest(req.params.id);
  return ok(res, { deleted: protest.id });
});

router.get('/protests/:id/kpi', (req, res) => {
  const kpi = store.buildKpi(req.params.id);
  if (!kpi) return res.status(404).json({ ok: false, error: 'Protest not found.' });
  return ok(res, { kpi, protocol: { version: PROTOCOL.version, hash: PROTOCOL_HASH } });
});

router.get('/protests/:id/joiners', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 50);
  const since = req.query.since ? String(req.query.since) : undefined;
  return ok(res, {
    joiners: store.listJoiners(req.params.id, { limit, since }).map((j) => ({
      name: j.name,
      country: j.country,
      countryName: j.countryName,
      city: j.city,
      region: j.region,
      gender: j.gender,
      ageBand: j.ageBand,
      channel: j.channel,
      injected: j.injected,
      at: j.at,
    })),
  });
});

// ---------------------------------------------------------------------------
// Live stream (SSE)
// ---------------------------------------------------------------------------

router.get('/protests/:id/stream', (req, res) => {
  const protest = store.getProtest(req.params.id);
  if (!protest) return res.status(404).json({ ok: false, error: 'Protest not found.' });
  return events.subscribe(protest.id, res);
});

router.get('/live/:id/overlay', (req, res) => {
  // Lightweight endpoint for stream overlays and kiosk screens.
  const kpi = store.buildKpi(req.params.id);
  if (!kpi) return res.status(404).json({ ok: false, error: 'Protest not found.' });
  const protest = store.getProtest(req.params.id);
  return ok(res, {
    overlay: {
      headline: protest.headline,
      phase: store.protestPhase(protest),
      total: kpi.total,
      countries: kpi.countryCount,
      cities: kpi.cityCount,
      topCountries: kpi.countries.slice(0, 8),
      genders: kpi.genders,
      ages: kpi.ages,
      progress: kpi.progress,
      updatedAt: kpi.updatedAt,
    },
  });
});

// ---------------------------------------------------------------------------
// Joining: online
// ---------------------------------------------------------------------------

function buildJoinContext({ protest, location }) {
  return {
    protestId: protest.id,
    headline: protest.headline,
    protocol: { version: PROTOCOL.version, hash: PROTOCOL_HASH },
    location,
  };
}

router.post('/protests/:id/join', (req, res) => {
  const body = req.body || {};
  const protest = store.getProtest(req.params.id);
  if (!protest) return res.status(404).json({ ok: false, error: 'Protest not found.' });

  validateProtocolVersion(body.protocolVersion);
  const consent = normalizeConsent(body.consent);
  const ageBand = ageToBand(body.age);
  const gender = normalizeGender(body.gender);

  const deviceSeed = String(body.deviceSeed || '').trim();
  const location = resolveLocation(body.location || {});

  const result = store.joinProtest(protest.id, {
    deviceSeed,
    ageBand,
    gender,
    location,
    channel: String(body.channel || 'web'),
    consent,
  });

  if (!result.duplicate) {
    events.publishJoin(protest.id, result.joiner);
  }
  events.markDirty(protest.id);

  return ok(
    res,
    {
      joiner: {
        name: result.joiner.name,
        anonId: result.joiner.anonId,
        ageBand: result.joiner.ageBand,
        gender: result.joiner.gender,
        country: result.joiner.country,
        countryName: result.joiner.countryName,
        region: result.joiner.region,
        city: result.joiner.city,
        channel: result.joiner.channel,
        at: result.joiner.at,
      },
      duplicate: result.duplicate,
      context: buildJoinContext({ protest, location: result.joiner }),
      protest: { id: protest.id, headline: protest.headline, phase: store.protestPhase(protest) },
    },
    result.duplicate ? 200 : 201
  );
});

// ---------------------------------------------------------------------------
// Joining: offline / Bluetooth / hotspot
// ---------------------------------------------------------------------------

/**
 * A "beacon" is what an offline joiner scans or receives over Bluetooth: it
 * carries the protest id, protocol hash and a short-lived pairing code. It can be
 * printed on a poster, shown on a phone, or emitted by a BLE beacon.
 */
router.get('/protests/:id/beacon', async (req, res) => {
  const protest = store.getProtest(req.params.id);
  if (!protest) return res.status(404).json({ ok: false, error: 'Protest not found.' });

  const origin = `${req.protocol}://${req.get('host')}`;
  const pairing = store.issuePairingCode(protest.id, {
    code: protest.pairingCode,
    origin,
    ttlMs: config.pairingCodeTtlMs,
  });
  const beacon = buildBeacon({
    protestId: protest.id,
    origin,
    pairingCode: pairing.code,
    createdAt: Date.parse(pairing.createdAt),
  });
  const payload = encodeBeacon(beacon);
  const joinUrl = `${origin}/join.html?p=${encodeURIComponent(protest.id)}&c=${pairing.code}`;
  const qr = await QRCode.toDataURL(payload, { margin: 1, width: 512 });

  return ok(res, {
    beacon,
    payload,
    joinUrl,
    qr,
    qrJoin: await QRCode.toDataURL(joinUrl, { margin: 1, width: 512 }),
    expiresAt: pairing.expiresAt,
  });
});

router.post('/join/offline', (req, res) => {
  const body = req.body || {};
  let beacon;
  try {
    beacon = body.beacon ? decodeBeacon(body.beacon) : body;
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message, code: err.code });
  }

  const pairing = store.resolvePairingCode(beacon.c || body.pairingCode);
  if (!pairing) {
    return res.status(400).json({
      ok: false,
      error: 'This offline code is not recognised. Rescan a current code from the protest page.',
      code: 'pairing_unknown',
    });
  }
  if (pairing.expired) {
    return res.status(400).json({
      ok: false,
      error: 'This offline code has expired. Rescan a current code (codes refresh every 15 minutes).',
      code: 'pairing_expired',
    });
  }

  const protest = store.getProtest(pairing.protestId);
  if (!protest) return res.status(404).json({ ok: false, error: 'Protest not found.' });

  try {
    validateProtocolVersion(beacon.v || body.protocolVersion);
    normalizeConsent(body.consent);
    const ageBand = ageToBand(body.age);
    const gender = normalizeGender(body.gender);
    const location = resolveLocation(body.location || {});
    const deviceSeed = String(body.deviceSeed || '').trim();

    const result = store.joinProtest(protest.id, {
      deviceSeed,
      ageBand,
      gender,
      location,
      channel: String(body.channel || 'offline-queue'),
    });

    store.countPairingUse(pairing.code);
    events.markDirty(protest.id);
    if (!result.duplicate) events.publishJoin(protest.id, result.joiner);

    return ok(
      res,
      {
        joiner: {
          name: result.joiner.name,
          anonId: result.joiner.anonId,
          ageBand: result.joiner.ageBand,
          gender: result.joiner.gender,
          country: result.joiner.countryName,
          city: result.joiner.city,
          channel: result.joiner.channel,
        },
        duplicate: result.duplicate,
        protest: { id: protest.id, headline: protest.headline },
        message: 'Your offline join was accepted and counted worldwide.',
      },
      result.duplicate ? 200 : 201
    );
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw err;
  }
});

/**
 * Issue an offline envelope: a signed token the device can store and hand to a
 * mesh relay later. It lets someone join with no internet at all and sync when
 * they reach a hotspot, while the server can still verify the code was genuine.
 */
router.post('/join/offline/envelope', (req, res) => {
  const body = req.body || {};
  const pairing = store.resolvePairingCode(body.pairingCode);
  if (!pairing || pairing.expired) {
    return res.status(400).json({ ok: false, error: 'Pairing code is unknown or expired.' });
  }
  const payload = {
    t: 'wdp-join',
    v: PROTOCOL.version,
    h: PROTOCOL_HASH,
    p: pairing.protestId,
    c: pairing.code,
    iat: Date.now(),
    exp: Date.parse(pairing.expiresAt),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  return ok(res, { envelope: signEnvelope(payload, offlineSecret(pairing.code)), payload });
});

router.post('/join/offline/sync', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length > 5000) {
    return res.status(413).json({ ok: false, error: 'Sync batch too large (max 5000).' });
  }
  const results = [];
  for (const item of items) {
    try {
      const payload = verifyEnvelope(item.envelope, offlineSecret(item.pairingCode));
      if (payload.exp && Date.now() > payload.exp) {
        throw new ProtocolError('Envelope expired before sync.', 'envelope_expired');
      }
      const protest = store.getProtest(payload.p);
      if (!protest) throw new ProtocolError('Protest not found.', 'not_found');
      validateProtocolVersion(payload.v);
      const ageBand = ageToBand(item.age);
      const gender = normalizeGender(item.gender);
      const location = resolveLocation(item.location || {});
      const result = store.joinProtest(protest.id, {
        deviceSeed: String(item.deviceSeed || payload.nonce || '').trim(),
        ageBand,
        gender,
        location,
        channel: String(item.channel || 'offline-queue'),
      });
      events.markDirty(protest.id);
      results.push({
        ok: true,
        name: result.joiner.name,
        anonId: result.joiner.anonId,
        duplicate: result.duplicate,
        protestId: protest.id,
      });
    } catch (err) {
      results.push({ ok: false, error: err.message, code: err.code || 'error' });
    }
  }
  const accepted = results.filter((r) => r.ok).length;
  return ok(res, { accepted, rejected: results.length - accepted, results });
});

/** Decode a scanned code without joining (used by the join page preview). */
router.post('/join/inspect', (req, res) => {
  try {
    const beacon = decodeBeacon(req.body?.code || req.body?.beacon);
    const protest = store.getProtest(beacon.p);
    return ok(res, {
      beacon,
      protest: protest ? store.serializeProtest(protest) : null,
      expired: Boolean(beacon.e && Date.now() > beacon.e),
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Protocol enforcement
// ---------------------------------------------------------------------------

router.post('/protests/:id/report', (req, res) => {
  const report = store.addReport({ ...req.body, protestId: req.params.id });
  return ok(res, { report }, 201);
});

router.get('/reports', (req, res) => ok(res, { reports: store.listReports() }));

// Physical presence: requested, verified, then scheduled. Never automatic.
router.post('/protests/:id/physical-request', (req, res) => {
  const body = req.body || {};
  assertPeacefulLanguage(body.area, body.availability, body.name, body.city);
  const request = store.addPhysicalRequest({ ...body, protestId: req.params.id });
  const verification = store.addVerification({
    requestId: request.id,
    protestId: request.protestId,
    step: 'identity-and-intent',
    status: 'pending',
  });
  return ok(
    res,
    {
      request,
      verification,
      message:
        'Request received. Physical presence is only scheduled after verification, and every scheduled group follows the same protocol.',
    },
    201
  );
});

router.get('/protests/:id/physical-requests', (req, res) =>
  ok(res, { requests: store.listPhysicalRequests(req.params.id) })
);

// ---------------------------------------------------------------------------
// Test injection (validated global data before a real protest)
// ---------------------------------------------------------------------------

router.get('/test/injection/meta', requireInjection, (req, res) =>
  ok(res, { meta: injectionMeta() })
);

router.post('/test/inject/:id', requireInjection, async (req, res) => {
  const body = req.body || {};
  const result = await injectParticipants(req.params.id, {
    count: body.count,
    countries: body.countries,
    spreadMinutes: body.spreadMinutes,
    batch: body.batch,
  });
  events.markDirty(req.params.id);
  return ok(res, { result, kpi: store.buildKpi(req.params.id) });
});

router.post('/test/inject/:id/worldwide', requireInjection, async (req, res) => {
  const result = await injectWorldwide(req.params.id, {
    perCountry: req.body?.perCountry,
    countries: req.body?.countries,
  });
  events.markDirty(req.params.id);
  return ok(res, { result, kpi: store.buildKpi(req.params.id) });
});

router.post('/test/inject/:id/clear', requireInjection, (req, res) => {
  const removed = store.clearInjections(req.params.id);
  events.markDirty(req.params.id);
  return ok(res, { removed, kpi: store.buildKpi(req.params.id) });
});

// ---------------------------------------------------------------------------
// Platform state
// ---------------------------------------------------------------------------

router.get('/status', (req, res) => {
  const protests = store.listProtests();
  const totals = protests.reduce(
    (acc, p) => ({
      total: acc.total + (p.totals?.total || 0),
      real: acc.real + (p.totals?.real || 0),
      injected: acc.injected + (p.totals?.injected || 0),
      countries: Math.max(acc.countries, p.totals?.countries || 0),
      live: acc.live + (p.phase === 'live' ? 1 : 0),
    }),
    { total: 0, real: 0, injected: 0, countries: 0, live: 0 }
  );
  ok(res, {
    status: {
      version: config.protocolVersion,
      protocolHash: PROTOCOL_HASH,
      injectionEnabled: config.enableTestInjection,
      protests: protests.length,
      liveViewers: events.totalClients(),
      totals,
      geo: geodbStats(),
      youtube: { channelUrl: config.youtubeChannelUrl },
      serverTime: new Date().toISOString(),
    },
  });
});

router.get('/audit', (req, res) => ok(res, { audit: store.auditLog().slice(0, 200) }));

export default router;
