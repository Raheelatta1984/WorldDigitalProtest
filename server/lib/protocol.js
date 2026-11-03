import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * THE PROTOCOL
 * -------------
 * Every protest on this platform runs the same protocol. There are no local
 * variants, no organiser overrides and no exceptions. It is the only thing a
 * joiner has to accept, and it is the reason the platform can promise peaceful
 * participation without a physical crowd to police.
 *
 * The protocol is also a wire contract: offline join envelopes carry the
 * protocol version + hash they accepted, so queued offline data cannot be
 * replayed under different rules.
 */

export const ARTICLES = [
  {
    id: 'peace',
    number: 1,
    title: 'Peace is the method',
    summary: 'This is a peaceful protest. Non-violence is not a suggestion, it is the entry requirement.',
    rules: [
      'No violence, threats, intimidation or harassment towards anyone.',
      'No weapons, no objects carried to cause harm, no property damage.',
      'No hate speech, slurs, or targeting of people by identity.',
      'If you see escalation, disengage and report it. Never respond with force.',
    ],
  },
  {
    id: 'one-protocol',
    number: 2,
    title: 'One protocol, everywhere',
    summary: 'The same rules apply in every country, city and suburb, at every hour of the protest.',
    rules: [
      'No country, group or organiser can amend, waive or localise these rules.',
      'A larger turnout never outranks the protocol.',
      'Anything that breaks the protocol is removed from the protest and from every count.',
    ],
  },
  {
    id: 'no-travel',
    number: 3,
    title: 'Nobody has to travel',
    summary: 'Digital presence is full participation. No physical attendance is ever required to take part.',
    rules: [
      'Joining from home, work, school or a bus is equal participation.',
      'The platform never asks you to go to a place.',
      'Any physical gathering is a separate, optional, verified and scheduled activity.',
    ],
  },
  {
    id: 'privacy',
    number: 4,
    title: 'Nothing personal, by design',
    summary: 'We never ask for your name, ID, address, email or phone number.',
    rules: [
      'You are given a generated protester name when you join.',
      'Only an age range and a gender selection are collected.',
      'No location is collected beyond the country, city and area used for the count.',
      'No advertising, no profiling, no sale of participation data.',
    ],
  },
  {
    id: 'accuracy',
    number: 5,
    title: 'Numbers must be honest',
    summary: 'Everyone on the count is a real acceptance of this protocol. We never inflate a count.',
    rules: [
      'Test/injected participants are always labelled as injected and never mixed silently into real numbers.',
      'No fabricated screenshots, no impersonation of officials or media.',
      'Progress against targets is reported exactly as recorded.',
    ],
  },
  {
    id: 'safety',
    number: 6,
    title: 'Protect other people',
    summary: 'Your right to protest does not include exposing someone else to harm.',
    rules: [
      'No doxxing, no sharing of anyone else’s address, workplace or identity.',
      'No filming of identifiable bystanders for the purpose of targeting them.',
      'No coordinating blockades, occupations or confrontations through this platform.',
    ],
  },
  {
    id: 'lawful',
    number: 7,
    title: 'Lawful conduct, always',
    summary: 'This protocol does not override the law where you live, and it never excuses breaking it.',
    rules: [
      'You remain responsible for your own lawful conduct.',
      'Nothing here coordinates a physical assembly, march or obstruction.',
      'If local law restricts an activity, you do not use this platform to do it.',
    ],
  },
  {
    id: 'enforcement',
    number: 8,
    title: 'Enforcement is automatic',
    summary: 'The protocol enforces itself through the platform, not through a crowd.',
    rules: [
      'A joiner who breaches the protocol is removed from the count and cannot rejoin that protest.',
      'Violent-incitement language is blocked when a protest or update is created.',
      'Breaches can be reported from any protest page and are queued for review.',
    ],
  },
];

export const CONSENT_KEYS = ['nonViolence', 'noPersonalData', 'peacefulOnly', 'oneProtocol'];

export const CONSENT_LABELS = {
  nonViolence: 'I will take part only peacefully: no violence, threats, weapons or property damage.',
  noPersonalData: 'I understand the platform stores no personal information about me, only an age range and gender.',
  peacefulOnly: 'I will not use this protest to coordinate violence, blockades or illegal activity.',
  oneProtocol: 'I accept this same protocol for every protest on the platform, in every country.',
};

export const AGE_BANDS = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
export const GENDERS = ['female', 'male', 'non-binary', 'undisclosed'];
export const GENDER_LABELS = {
  female: 'Female',
  male: 'Male',
  'non-binary': 'Non-binary',
  undisclosed: 'Prefer not to say',
};

export const MIN_AGE = 13;
export const MAX_AGE = 120;

/** Stable hash of the protocol content; envelopes must match it. */
export const PROTOCOL_HASH = crypto
  .createHash('sha256')
  .update(
    JSON.stringify({
      version: config.protocolVersion,
      articles: ARTICLES.map((a) => [a.id, a.rules]),
      consent: CONSENT_KEYS,
      ageBands: AGE_BANDS,
      genders: GENDERS,
    })
  )
  .digest('hex')
  .slice(0, 32);

export const PROTOCOL = {
  version: config.protocolVersion,
  hash: PROTOCOL_HASH,
  title: 'The World Digital Protest Protocol',
  preamble:
    'There is one protocol for every protest on this platform, for every participant, in every country. ' +
    'It exists because a protest of millions that never gathers in one place must still be governed by one ' +
    'clear, peaceful, verifiable standard.',
  articles: ARTICLES,
  consent: CONSENT_KEYS.map((key) => ({ key, label: CONSENT_LABELS[key] })),
  ageBands: AGE_BANDS,
  genders: GENDERS.map((key) => ({ key, label: GENDER_LABELS[key] })),
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ProtocolError extends Error {
  constructor(message, code = 'protocol_violation', details = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = 400;
    this.details = details;
  }
}

export function ageToBand(age) {
  const n = Number(age);
  if (!Number.isFinite(n) || n < MIN_AGE || n > MAX_AGE) {
    throw new ProtocolError(`Age must be a number between ${MIN_AGE} and ${MAX_AGE}.`, 'invalid_age');
  }
  if (n <= 17) return '13-17';
  if (n <= 24) return '18-24';
  if (n <= 34) return '25-34';
  if (n <= 44) return '35-44';
  if (n <= 54) return '45-54';
  if (n <= 64) return '55-64';
  return '65+';
}

export function normalizeGender(gender) {
  const g = String(gender || '').toLowerCase().trim();
  const aliases = {
    woman: 'female',
    f: 'female',
    man: 'male',
    m: 'male',
    enby: 'non-binary',
    nb: 'non-binary',
    nonbinary: 'non-binary',
    'non binary': 'non-binary',
    other: 'non-binary',
    'prefer not to say': 'undisclosed',
    'rather not say': 'undisclosed',
    private: 'undisclosed',
    secret: 'undisclosed',
  };
  const value = aliases[g] || g;
  if (!GENDERS.includes(value)) {
    throw new ProtocolError('Select a gender option (or prefer not to say).', 'invalid_gender');
  }
  return value;
}

/**
 * Consent must be complete and affirmative. There is no "partial" participation:
 * accepting the protocol is what makes a joiner count.
 */
export function normalizeConsent(consent = {}) {
  if (typeof consent === 'string') {
    try {
      consent = JSON.parse(consent);
    } catch {
      consent = {};
    }
  }
  const accepted = {};
  const missing = [];
  for (const key of CONSENT_KEYS) {
    const value = Boolean(consent[key]);
    accepted[key] = value;
    if (!value) missing.push(key);
  }
  if (missing.length) {
    throw new ProtocolError(
      'All protocol agreements must be accepted to join.',
      'consent_required',
      { missing, labels: missing.map((k) => CONSENT_LABELS[k]) }
    );
  }
  return accepted;
}

export function validateProtocolVersion(version) {
  if (String(version || '') !== String(config.protocolVersion)) {
    throw new ProtocolError(
      `This join was prepared under protocol ${version || 'unknown'}, but the current protocol is ${config.protocolVersion}. Please re-accept the protocol.`,
      'protocol_version_mismatch',
      { expected: config.protocolVersion, received: version || null, hash: PROTOCOL_HASH }
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Language screening: block violent incitement at creation time
// ---------------------------------------------------------------------------

const VIOLENT_PATTERNS = [
  /\b(kill|murder|assassinate|execute|behead)\b/i,
  /\b(bomb|explosive|ied|molotov|arson|firebomb)\b/i,
  /\b(burn (down|them|their|the)|torch (them|their|the))\b/i,
  /\b(riot|loot|pillage|vandal\w*)\b/i,
  /\b(armed|weapons?|guns?|knives|rifles?)\b/i,
  /\b(hang|lynch|beat (them|him|her) up)\b/i,
  /\b(kill (all|every|the)|death to)\b/i,
  /\b(hostage|kidnap)\b/i,
  /\b(stab|shoot)\b/i,
];

/**
 * Screens organiser-supplied text. Returns the flags found so the UI can explain
 * exactly what needs rewording rather than failing silently.
 */
export function screenText(...texts) {
  const combined = texts.filter(Boolean).join(' \n ');
  const flags = [];
  for (const pattern of VIOLENT_PATTERNS) {
    const match = combined.match(pattern);
    if (match) flags.push(match[0].toLowerCase());
  }
  return {
    ok: flags.length === 0,
    flags: [...new Set(flags)],
  };
}

export function assertPeacefulLanguage(...texts) {
  const result = screenText(...texts);
  if (!result.ok) {
    throw new ProtocolError(
      'Protocol article 1 and 8 block calls to violence. Reword the text before publishing.',
      'violent_language_blocked',
      { flagged: result.flags }
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Offline envelope signing / verification
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(String(str), 'base64url');

export function signEnvelope(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyEnvelope(envelope, secret) {
  if (typeof envelope !== 'string' || envelope.split('.').length !== 2) {
    throw new ProtocolError('Malformed offline envelope.', 'envelope_malformed');
  }
  const [body, sig] = envelope.split('.');
  const expected = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ProtocolError('Offline envelope signature is not valid for this credential.', 'envelope_bad_signature');
  }
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    throw new ProtocolError('Offline envelope payload could not be read.', 'envelope_unreadable');
  }
  return payload;
}

/** Beacon payload carried in QR codes / Bluetooth beacons (no secret inside). */
export function buildBeacon({ protestId, origin, pairingCode, createdAt = Date.now() }) {
  return {
    t: 'wdp-beacon',
    v: config.protocolVersion,
    h: PROTOCOL_HASH,
    p: protestId,
    o: origin,
    c: pairingCode,
    a: createdAt,
    e: createdAt + config.pairingCodeTtlMs,
  };
}

export function encodeBeacon(beacon) {
  return `wdp1:${b64url(JSON.stringify(beacon))}`;
}

export function decodeBeacon(raw) {
  const text = String(raw || '').trim();
  const body = text.startsWith('wdp1:') ? text.slice(5) : text;
  let parsed;
  try {
    parsed = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    throw new ProtocolError('This code is not a World Digital Protest beacon.', 'beacon_invalid');
  }
  if (parsed.t !== 'wdp-beacon') {
    throw new ProtocolError('This code is not a World Digital Protest beacon.', 'beacon_invalid');
  }
  return parsed;
}
