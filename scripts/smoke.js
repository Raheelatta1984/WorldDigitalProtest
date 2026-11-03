/**
 * End-to-end smoke check against a running instance.
 *
 *   node scripts/smoke.js [baseUrl]
 *
 * Verifies, in order: protocol integrity, peace screening, an online join, an
 * offline beacon join, signed-envelope sync (accept + reject), KPI consistency,
 * worldwide test injection, and the live SSE channel.
 */
const base = (process.argv[2] || process.env.WDP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

let failures = 0;
const pass = (label, detail) => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail) => {
  failures += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (label, condition, detail) => (condition ? pass(label, detail) : fail(label, detail));

async function api(pathname, options = {}) {
  const res = await fetch(`${base}/api${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const consent = { nonViolence: true, noPersonalData: true, peacefulOnly: true, oneProtocol: true };

async function main() {
  console.log(`\nWorld Digital Protest — smoke check against ${base}\n`);

  // 1. health + protocol
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  check('server is healthy', health.ok === true, `protocol ${health.protocol}`);
  check('geo coverage >= 200 countries', health.geo.countries >= 200, `${health.geo.countries} countries`);
  check('geo coverage > 50k areas', health.geo.cities > 50000, `${health.geo.cities.toLocaleString()} areas`);

  const { json: proto } = await api('/protocol');
  check('protocol has 8 articles', proto.protocol.articles.length === 8);
  check('protocol exposes 4 required agreements', proto.protocol.consent.length === 4);
  check('protocol hash is present', /^[0-9a-f]{32}$/.test(proto.hash), proto.hash);

  // 2. peace screening
  const blocked = await api('/protests', {
    method: 'POST',
    body: {
      headline: 'Burn down the ministry with weapons tonight',
      reason: 'We will attack the building and shoot anyone who stops us until they surrender.',
    },
  });
  check('violent protest text is blocked', blocked.status === 400 && blocked.json.code === 'violent_language_blocked');

  const peaceful = await api('/protests', {
    method: 'POST',
    body: {
      id: `smoke-${Date.now().toString(36)}`,
      headline: 'Smoke check: a peaceful worldwide protest',
      reason: 'Created by the smoke script to validate the full join and KPI path end to end.',
      targetJoiners: 1000,
    },
  });
  check('peaceful protest can be published', peaceful.status === 201);
  const protestId = peaceful.json.protest?.id;

  // 3. online join
  const join = await api(`/protests/${protestId}/join`, {
    method: 'POST',
    body: {
      protocolVersion: '1.0',
      consent,
      age: 30,
      gender: 'female',
      deviceSeed: `smoke-device-${Date.now()}`,
      location: { lat: -33.8688, lng: 151.2093 },
    },
  });
  check('online join is accepted', join.status === 201, join.json.joiner?.name);
  check('join resolves country + city', join.json.joiner?.country === 'AU' && join.json.joiner?.city === 'Sydney');
  check('join returns no personal identifiers', !/email|phone|address/i.test(JSON.stringify(join.json)));

  const partial = await api(`/protests/${protestId}/join`, {
    method: 'POST',
    body: { protocolVersion: '1.0', consent: { nonViolence: true }, age: 30, gender: 'male', deviceSeed: 'smoke-partial-000' },
  });
  check('partial consent is rejected', partial.status === 400 && partial.json.code === 'consent_required');

  // 4. offline beacon join + envelope sync
  const beacon = await api(`/protests/${protestId}/beacon`);
  check('beacon payload issued', beacon.json.payload?.startsWith('wdp1:'));
  check('beacon has a QR image', beacon.json.qr?.startsWith('data:image/png'));

  const offline = await api('/join/offline', {
    method: 'POST',
    body: {
      beacon: beacon.json.payload,
      consent,
      age: 52,
      gender: 'non-binary',
      deviceSeed: `smoke-offline-${Date.now()}`,
      location: { country: 'KE', city: 'Nairobi' },
      channel: 'bluetooth',
    },
  });
  check('offline beacon join is accepted', offline.status === 201, `${offline.json.joiner?.city}, ${offline.json.joiner?.country}`);

  const code = beacon.json.beacon.c;
  const env = await api('/join/offline/envelope', { method: 'POST', body: { pairingCode: code } });
  const sync = await api('/join/offline/sync', {
    method: 'POST',
    body: {
      items: [
        {
          envelope: env.json.envelope,
          pairingCode: code,
          age: 41,
          gender: 'male',
          deviceSeed: `smoke-mesh-${Date.now()}`,
          location: { country: 'BR' },
        },
        { envelope: 'forged.signature', pairingCode: code, age: 41, gender: 'male', deviceSeed: 'smoke-forged-1' },
      ],
    },
  });
  check('signed envelope is accepted on sync', sync.json.accepted === 1);
  check('forged envelope is rejected', sync.json.rejected === 1 && sync.json.results[1].code === 'envelope_bad_signature');

  // 5. KPI consistency
  const { json: kpiWrap } = await api(`/protests/${protestId}/kpi`);
  const kpi = kpiWrap.kpi;
  check('KPI total counts the accepted joins', kpi.total >= 3, `${kpi.total}`);
  check('country counts sum to total', kpi.countries.reduce((s, c) => s + c.count, 0) === kpi.total);
  check('gender counts sum to total', kpi.genders.reduce((s, g) => s + g.count, 0) === kpi.total);
  check('age counts sum to total', kpi.ages.reduce((s, a) => s + a.count, 0) === kpi.total);
  check('real + injected equals total', kpi.real + kpi.injected === kpi.total);
  check('every country has map coordinates', kpi.countries.every((c) => c.lat && c.lng));

  // 6. live stream (SSE)
  const streamed = await new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, 6000);
    fetch(`${base}/api/protests/${protestId}/stream`, { signal: controller.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.includes('event: snapshot') && buffer.includes('event: hello')) {
            clearTimeout(timer);
            controller.abort();
            resolve(true);
            return;
          }
        }
        resolve(false);
      })
      .catch(() => resolve(false));
  });
  check('live SSE channel replays a snapshot', streamed === true);

  // 7. test injection (labelled and reversible)
  const injected = await api(`/test/inject/${protestId}/worldwide`, {
    method: 'POST',
    body: { perCountry: 1 },
  });
  if (injected.status === 200) {
    check('worldwide injection reaches 200+ countries', injected.json.result.countries >= 200, `${injected.json.result.countries}`);
    check('injected participants are labelled', injected.json.kpi.injected === injected.json.result.injected);
    const cleared = await api(`/test/inject/${protestId}/clear`, { method: 'POST' });
    check('injected participants can be cleared', cleared.json.kpi.injected === 0, `removed ${cleared.json.removed}`);
  } else {
    fail('test injection endpoint', `status ${injected.status} (disabled on this deployment?)`);
  }

  // 8. pages
  for (const page of ['/', '/protests.html', '/protest.html', '/join.html', '/offline.html', '/protocol.html', '/testlab.html', '/overlay.html']) {
    const res = await fetch(`${base}${page}`);
    check(`page ${page} serves`, res.status === 200);
  }

  await api(`/protests/${protestId}`, { method: 'DELETE' });

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nSmoke check crashed: ${err.message}\n`);
  process.exit(1);
});
