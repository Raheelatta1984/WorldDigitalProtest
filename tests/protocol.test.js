import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL,
  PROTOCOL_HASH,
  CONSENT_KEYS,
  ageToBand,
  normalizeGender,
  normalizeConsent,
  screenText,
  assertPeacefulLanguage,
  validateProtocolVersion,
  signEnvelope,
  verifyEnvelope,
  buildBeacon,
  encodeBeacon,
  decodeBeacon,
  ProtocolError,
} from '../server/lib/protocol.js';
import { generateProtesterName } from '../server/lib/pseudonym.js';

test('protocol is versioned and hashed', () => {
  assert.equal(PROTOCOL.version, '1.0');
  assert.match(PROTOCOL_HASH, /^[0-9a-f]{32}$/);
  assert.equal(PROTOCOL.articles.length, 8);
  assert.equal(PROTOCOL.consent.length, 4);
});

test('every article says something enforceable', () => {
  for (const article of PROTOCOL.articles) {
    assert.ok(article.title.length > 3);
    assert.ok(article.summary.length > 20);
    assert.ok(article.rules.length >= 3);
  }
});

test('age is reduced to a band, never stored exactly', () => {
  assert.equal(ageToBand(13), '13-17');
  assert.equal(ageToBand(17), '13-17');
  assert.equal(ageToBand(18), '18-24');
  assert.equal(ageToBand(34), '25-34');
  assert.equal(ageToBand(80), '65+');
  assert.throws(() => ageToBand(12), ProtocolError);
  assert.throws(() => ageToBand('abc'), ProtocolError);
});

test('gender accepts aliases but rejects junk', () => {
  assert.equal(normalizeGender('Woman'), 'female');
  assert.equal(normalizeGender('nb'), 'non-binary');
  assert.equal(normalizeGender('prefer not to say'), 'undisclosed');
  assert.throws(() => normalizeGender('dragon'), ProtocolError);
});

test('consent must be complete and affirmative', () => {
  const full = Object.fromEntries(CONSENT_KEYS.map((k) => [k, true]));
  assert.deepEqual(normalizeConsent(full), full);

  assert.throws(() => normalizeConsent({ nonViolence: true }), (err) => {
    assert.equal(err.code, 'consent_required');
    assert.deepEqual(err.details.missing.sort(), CONSENT_KEYS.filter((k) => k !== 'nonViolence').sort());
    return true;
  });
});

test('protocol version mismatch is refused', () => {
  assert.equal(validateProtocolVersion('1.0'), true);
  assert.throws(() => validateProtocolVersion('0.9'), (err) => err.code === 'protocol_version_mismatch');
});

test('violent language is screened out, peaceful language passes', () => {
  assert.equal(screenText('We demand clean water for every household.').ok, true);
  assert.equal(screenText('Let us meet peacefully and read the report together.').ok, true);

  const violent = screenText('Burn down the ministry and bring weapons', 'we will shoot them');
  assert.equal(violent.ok, false);
  assert.ok(violent.flags.length >= 2);
  assert.throws(() => assertPeacefulLanguage('Bring molotov cocktails'), (err) => {
    assert.equal(err.code, 'violent_language_blocked');
    return true;
  });
});

test('offline envelopes are signed and tamper-evident', () => {
  const payload = { t: 'wdp-join', p: 'climate-clock', v: '1.0', n: 1 };
  const env = signEnvelope(payload, 'secret-code');
  assert.deepEqual(verifyEnvelope(env, 'secret-code'), payload);

  assert.throws(() => verifyEnvelope(env, 'wrong-code'), (err) => err.code === 'envelope_bad_signature');

  const [body] = env.split('.');
  const forged = `${body}.${'A'.repeat(43)}`;
  assert.throws(() => verifyEnvelope(forged, 'secret-code'));
});

test('beacons round-trip and reject foreign codes', () => {
  const beacon = buildBeacon({ protestId: 'climate-clock', origin: 'http://x', pairingCode: 'ABC123' });
  const encoded = encodeBeacon(beacon);
  assert.ok(encoded.startsWith('wdp1:'));
  const decoded = decodeBeacon(encoded);
  assert.equal(decoded.p, 'climate-clock');
  assert.equal(decoded.c, 'ABC123');
  assert.ok(decoded.e > decoded.a);

  assert.throws(() => decodeBeacon('wdp1:not-json'), (err) => err.code === 'beacon_invalid');
  assert.throws(() => decodeBeacon('hello'), (err) => err.code === 'beacon_invalid');
});

test('generated protester names are stable, neutral and unique enough', () => {
  const a = generateProtesterName('protest:device-1');
  const b = generateProtesterName('protest:device-1');
  const c = generateProtesterName('protest:device-2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[A-Za-z]+ [A-Za-z]+ #\d{4}$/);
  // No name may resemble an email, a phone number or a real-name field.
  assert.ok(!a.includes('@'));
});
