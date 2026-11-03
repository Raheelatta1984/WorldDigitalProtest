import { ProtocolError, CONSENT_KEYS } from './protocol.js';

/**
 * Anonymous protester profiles.
 *
 * We never collect a real name. On joining, the platform generates a protest
 * name for the participant from a deterministic pool of neutral, non-identifying
 * words plus a short check code. The same joiner keeps the same name for the
 * protest they joined, which makes the roster readable without identifying anyone.
 */

const ADJECTIVES = [
  'Quiet', 'Steady', 'Open', 'Gentle', 'Clear', 'Bright', 'Patient', 'Honest',
  'Calm', 'Kind', 'Fair', 'Wide', 'Still', 'Plain', 'Warm', 'Tidy',
  'Brave', 'Even', 'Sure', 'Free', 'Sunny', 'Lucid', 'Humble', 'Earnest',
  'Restless', 'Hopeful', 'Watchful', 'Thoughtful', 'Unshaken', 'Forthright',
  'Silent', 'Upright', 'Seasoned', 'Curious', 'Careful', 'Generous', 'Modest',
  'Practical', 'Reasonable', 'Amber', 'Blue', 'Green', 'Silver', 'Coral',
];

const NOUNS = [
  'Willow', 'Harbour', 'Lantern', 'Compass', 'Meadow', 'River', 'Anchor', 'Bridge',
  'Cedar', 'Falcon', 'Kite', 'Marble', 'Orchid', 'Pebble', 'Quill', 'Reed',
  'Sparrow', 'Thistle', 'Violet', 'Wave', 'Breeze', 'Candle', 'Delta', 'Ember',
  'Field', 'Garden', 'Hill', 'Island', 'Juniper', 'Kestrel', 'Lilac', 'Mango',
  'Nectar', 'Ocean', 'Pear', 'Quartz', 'Ridge', 'Stone', 'Tulip', 'Umber',
  'Valley', 'Wheat', 'Willow', 'Yarrow', 'Zenith', 'Bamboo', 'Cocoa', 'Dune',
  'Fern', 'Glade', 'Hazel', 'Iris', 'Jade', 'Kelpie', 'Lagoon', 'Maple',
];

function hashToInt(seed) {
  // FNV-1a 32-bit, stable across processes and platforms.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function generateProtesterName(seed) {
  if (!seed) throw new ProtocolError('A protester name needs a seed.', 'missing_seed');
  const h1 = hashToInt(`a:${seed}`);
  const h2 = hashToInt(`n:${seed}`);
  const adjective = ADJECTIVES[h1 % ADJECTIVES.length];
  const noun = NOUNS[h2 % NOUNS.length];
  const code = (hashToInt(`c:${seed}`) % 9000 + 1000).toString();
  return `${adjective} ${noun} #${code}`;
}

/**
 * A joiner's identity for a protest is their name + an anonymous id. Both are
 * derived, and the raw device credential never leaves the client in plain form.
 */
export function buildJoinerIdentity({ protestId, deviceSeed }) {
  const seed = `${protestId}:${deviceSeed}`;
  return {
    name: generateProtesterName(seed),
    anonId: hashToInt(`id:${seed}`).toString(36).padStart(7, '0'),
  };
}

export function assertConsentShape(consent) {
  return CONSENT_KEYS.every((k) => Boolean(consent?.[k]));
}
