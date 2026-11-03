/**
 * Integration tests: boot the real server on an ephemeral port against a
 * throwaway data directory, then exercise the full join / KPI / offline paths.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-test-'));
process.env.WDP_DATA_DIR = tmpDir;
process.env.WDP_SILENT = '1';
process.env.PORT = '0';

const { default: app } = await import('../server/app.js');
const store = await import('../server/lib/store.js');
const { PROTOCOL_HASH } = await import('../server/lib/protocol.js');

let server;
let base;

const consent = {
  nonViolence: true,
  noPersonalData: true,
  peacefulOnly: true,
  oneProtocol: true,
};

async function api(pathname, options = {}) {
  const res = await fetch(`${base}/api${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  store.loadDb();
  store.createProtest({
    id: 'test-protest',
    headline: 'A test protest for the whole world',
    reason: 'This exists so the integration suite can validate a worldwide count end to end.',
    targetJoiners: 10000,
  }).protocolHash = PROTOCOL_HASH;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('health endpoint reports protocol and geo coverage', async () => {
  const res = await fetch(`${base}/healthz`);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.protocol, '1.0');
  assert.ok(json.geo.cities > 50000);
  assert.ok(json.geo.countries >= 200);
});

test('joiner must accept the whole protocol', async () => {
  const res = await api('/protests/test-protest/join', {
    method: 'POST',
    body: { protocolVersion: '1.0', consent: { nonViolence: true }, age: 30, gender: 'female', deviceSeed: 'dev-aaaa-1111' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'consent_required');
});

test('joiner must be on the current protocol version', async () => {
  const res = await api('/protests/test-protest/join', {
    method: 'POST',
    body: { protocolVersion: '0.1', consent, age: 30, gender: 'female', deviceSeed: 'dev-bbbb-2222' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'protocol_version_mismatch');
});

test('online join records country, city and a generated name', async () => {
  const res = await api('/protests/test-protest/join', {
    method: 'POST',
    body: {
      protocolVersion: '1.0',
      consent,
      age: 29,
      gender: 'female',
      deviceSeed: 'dev-cccc-3333',
      location: { lat: -33.8688, lng: 151.2093 },
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.joiner.country, 'AU');
  assert.equal(res.json.joiner.city, 'Sydney');
  assert.equal(res.json.joiner.ageBand, '25-34');
  assert.match(res.json.joiner.name, /#\d{4}$/);
  // The response must not echo any personal detail.
  const raw = JSON.stringify(res.json);
  assert.ok(!/email|phone|street|postcode/i.test(raw));
});

test('a repeat join is idempotent, not a second participant', async () => {
  const body = {
    protocolVersion: '1.0',
    consent,
    age: 44,
    gender: 'male',
    deviceSeed: 'dev-dddd-4444',
    location: { country: 'BR' },
  };
  const first = await api('/protests/test-protest/join', { method: 'POST', body });
  const second = await api('/protests/test-protest/join', { method: 'POST', body });
  assert.equal(first.status, 201);
  assert.equal(second.json.duplicate, true);
  assert.equal(first.json.joiner.name, second.json.joiner.name);
});

test('offline beacon join works without a prior page load', async () => {
  const beaconRes = await api('/protests/test-protest/beacon');
  assert.equal(beaconRes.status, 200);
  const { payload } = beaconRes.json;
  assert.ok(payload.startsWith('wdp1:'));

  const join = await api('/join/offline', {
    method: 'POST',
    body: {
      beacon: payload,
      consent,
      age: 52,
      gender: 'non-binary',
      deviceSeed: 'offline-device-5555',
      location: { country: 'KE', city: 'Nairobi' },
      channel: 'bluetooth',
    },
  });
  assert.equal(join.status, 201);
  assert.equal(join.json.joiner.channel, 'bluetooth');
  assert.equal(join.json.joiner.country, 'Kenya');
});

test('expired or unknown pairing codes are refused', async () => {
  const res = await api('/protests/test-protest/beacon');
  const { beacon } = res.json;
  store.getDb().pairingCodes[beacon.c].expiresAt = new Date(Date.now() - 1000).toISOString();
  const join = await api('/join/offline', {
    method: 'POST',
    body: { beacon: res.json.payload, consent, age: 30, gender: 'male', deviceSeed: 'gone-6666' },
  });
  assert.equal(join.status, 400);
  assert.equal(join.json.code, 'pairing_expired');
});

test('offline envelopes sync and reject forgeries', async () => {
  const { json } = await api('/protests/test-protest/beacon');
  const code = json.beacon.c;
  const env = await api('/join/offline/envelope', { method: 'POST', body: { pairingCode: code } });
  assert.equal(env.status, 200);

  const sync = await api('/join/offline/sync', {
    method: 'POST',
    body: {
      items: [
        {
          envelope: env.json.envelope,
          pairingCode: code,
          age: 33,
          gender: 'female',
          deviceSeed: 'mesh-relay-7777',
          location: { country: 'IN' },
        },
        { envelope: 'forged.sig', pairingCode: code, age: 33, gender: 'male', deviceSeed: 'mesh-relay-8888' },
      ],
    },
  });
  assert.equal(sync.json.accepted, 1);
  assert.equal(sync.json.rejected, 1);
  assert.equal(sync.json.results[1].code, 'envelope_bad_signature');
});

test('KPI totals stay internally consistent', async () => {
  const { json } = await api('/protests/test-protest/kpi');
  const kpi = json.kpi;
  assert.ok(kpi.total >= 3);
  assert.equal(kpi.countries.reduce((s, c) => s + c.count, 0), kpi.total);
  assert.equal(kpi.genders.reduce((s, g) => s + g.count, 0), kpi.total);
  assert.equal(kpi.ages.reduce((s, a) => s + a.count, 0), kpi.total);
  assert.equal(kpi.real + kpi.injected, kpi.total);
  assert.ok(kpi.countries.every((c) => c.name && typeof c.share === 'number'));
  assert.ok(kpi.cities.length > 0);
});

test('violent protests cannot be published', async () => {
  const res = await api('/protests', {
    method: 'POST',
    body: {
      headline: 'Burn down the ministry tonight',
      reason: 'We will attack the building with molotov cocktails and weapons until they surrender.',
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'violent_language_blocked');
  assert.ok(res.json.details.flagged.length > 0);
});

test('a peaceful protest can be published and appears in the list', async () => {
  const created = await api('/protests', {
    method: 'POST',
    body: {
      id: 'second-test-protest',
      headline: 'Open the budget data in every country',
      reason: 'Public money should be readable by the public that paid it, in every country.',
      targetJoiners: 500,
    },
  });
  assert.equal(created.status, 201);
  const list = await api('/protests');
  assert.ok(list.json.protests.some((p) => p.id === 'second-test-protest'));
});

test('injection is labelled and reversible', async () => {
  const injected = await api('/test/inject/test-protest', {
    method: 'POST',
    body: { count: 400, spreadMinutes: 10 },
  });
  assert.equal(injected.status, 200);
  assert.equal(injected.json.result.injected, 400);
  assert.ok(injected.json.kpi.injected >= 400);
  assert.ok(injected.json.kpi.countryCount > 50);
  assert.equal(injected.json.kpi.real + injected.json.kpi.injected, injected.json.kpi.total);

  const cleared = await api('/test/inject/test-protest/clear', { method: 'POST' });
  assert.equal(cleared.json.removed, 400);
  assert.equal(cleared.json.kpi.injected, 0);
});

test('worldwide injection reaches every supported country', async () => {
  const res = await api('/test/inject/test-protest/worldwide', {
    method: 'POST',
    body: { perCountry: 2 },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.result.countries >= 200);
  assert.ok(res.json.kpi.countryCount >= 200);
  await api('/test/inject/test-protest/clear', { method: 'POST' });
});

test('breach reports are accepted and listed', async () => {
  const res = await api('/protests/test-protest/report', {
    method: 'POST',
    body: { category: 'harassment', detail: 'Someone is posting threats in the comment thread.' },
  });
  assert.equal(res.status, 201);
  const list = await api('/reports');
  assert.ok(list.json.reports.length >= 1);
});

test('physical presence requests go to verification, never auto-scheduled', async () => {
  const res = await api('/protests/test-protest/physical-request', {
    method: 'POST',
    body: {
      name: 'Test Requester',
      contact: 'verify-only',
      country: 'AU',
      city: 'Sydney',
      area: 'Newtown',
      availability: 'weekday evenings',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.request.verificationStatus, 'pending');
  assert.match(res.json.message, /verification/i);
});

test('geo resolve reduces a coordinate to an area without storing it', async () => {
  const res = await api('/geo/resolve', { method: 'POST', body: { lat: 51.5074, lng: -0.1278 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.location.country, 'GB');
  assert.equal(res.json.location.city, 'London');
  assert.ok(!('lat' in res.json.location));
});

test('static app and overlay routes are served', async () => {
  for (const page of ['/', '/protests.html', '/protocol.html', '/join.html', '/overlay.html', '/testlab.html']) {
    const res = await fetch(`${base}${page}`);
    assert.equal(res.status, 200, `${page} should serve`);
  }
  const map = await fetch(`${base}/assets/data/world.map.json`);
  assert.equal(map.status, 200);
  const json = await map.json();
  assert.ok(json.polygons.length > 100);
});
