import crypto from 'node:crypto';
import { AGE_BANDS, GENDERS } from './protocol.js';
import { listCountries, listCitiesInCountry, geodbStats } from './geo.js';
import { getProtest, addInjected, getStats, countryName, continentOf, flushSave } from './store.js';
import { generateProtesterName } from './pseudonym.js';

/**
 * Test-data injection.
 *
 * Before a real protest is opened, the organisation needs to see what a global
 * turn-out looks like: which countries light up, how the city and area lists
 * fill, whether the gender/age breakdowns render, and whether the live counter
 * survives a worldwide spike. Injected participants are always written with
 * `injected: true`, counted separately in every KPI payload, and can be wiped in
 * one call. They are never mixed silently into real numbers.
 */

const randomInt = (min, max) => crypto.randomInt(min, max + 1);

function weightedPick(entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = crypto.randomInt(0, Math.max(1, Math.floor(total)));
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

const AGE_WEIGHTS = [
  ['13-17', 6],
  ['18-24', 24],
  ['25-34', 28],
  ['35-44', 19],
  ['45-54', 13],
  ['55-64', 7],
  ['65+', 3],
];

const GENDER_WEIGHTS = [
  ['female', 47],
  ['male', 45],
  ['non-binary', 4],
  ['undisclosed', 4],
];

const CHANNELS = [
  ['web', 52],
  ['offline-queue', 12],
  ['bluetooth', 14],
  ['wifi-hotspot', 10],
  ['beacon-qr', 8],
  ['internet-link', 4],
];

function countryWeights() {
  return listCountries()
    .map((c) => [
      c.iso2,
      // Roughly population-proportional, with a floor so small countries still
      // appear in a modest test run rather than only the largest twenty.
      Math.max(1, Math.round(c.population / 1_000_000)) + 4,
    ])
    .filter(([cc]) => listCitiesInCountry(cc, { limit: 1 }).length > 0);
}

let cachedWeights = null;
function weights() {
  if (!cachedWeights) cachedWeights = countryWeights();
  return cachedWeights;
}

/** City-level weights inside one country: big metros dominate, suburbs still appear. */
const cityCache = new Map();
function cityWeights(cc) {
  if (cityCache.has(cc)) return cityCache.get(cc);
  const cities = listCitiesInCountry(cc, { limit: 40 });
  const list = cities.map((c) => [c, Math.max(1, Math.round(Math.sqrt(c.pop || 1000)))]);
  cityCache.set(cc, list);
  return list;
}

function makeJoiner({ protestId, cc, gender, ageBand, at, runId }) {
  const cities = cityWeights(cc);
  const city = cities.length ? weightedPick(cities) : null;
  if (!city) return null;
  return {
    anonId: `inj-${runId}-${crypto.randomBytes(6).toString('hex')}`,
    name: generateProtesterName(`inj:${runId}:${cc}:${crypto.randomUUID()}`),
    protestId,
    ageBand,
    gender,
    country: cc,
    countryName: countryName(cc),
    continent: continentOf(cc),
    region: city.region || '',
    city: city.name,
    cityId: city.id,
    channel: weightedPick(CHANNELS),
    injected: true,
    at,
  };
}

/**
 * @param {string} protestId
 * @param {object} options
 * @param {number} options.count           how many participants to inject
 * @param {string[]} [options.countries]   restrict to these ISO2 codes
 * @param {number} [options.batch]         inserts per tick (keeps the loop responsive)
 * @param {number} [options.spreadMinutes] fabricate arrivals over this window
 * @param {(p:{done:number,total:number})=>void} [options.onProgress]
 */
export async function injectParticipants(protestId, options = {}) {
  const protest = getProtest(protestId);
  if (!protest) throw new Error('Protest not found.');

  const count = Math.max(0, Math.min(500000, Number(options.count) || 0));
  const allowed = Array.isArray(options.countries) && options.countries.length
    ? new Set(options.countries.map((c) => String(c).toUpperCase()))
    : null;
  const pool = (allowed ? weights().filter(([cc]) => allowed.has(cc)) : weights());
  if (!count || !pool.length) return { injected: 0, total: getStats(protestId).total };

  const batch = Math.max(50, Math.min(25000, Number(options.batch) || 4000));
  const spreadMinutes = Math.max(0, Math.min(60 * 24 * 7, Number(options.spreadMinutes) || 45));
  const startedAt = Date.now() - spreadMinutes * 60000;
  const runId = crypto.randomBytes(4).toString('hex');

  let done = 0;
  while (done < count) {
    const size = Math.min(batch, count - done);
    let written = 0;
    for (let i = 0; i < size; i += 1) {
      const cc = weightedPick(pool);
      const at = new Date(
        spreadMinutes ? startedAt + (spreadMinutes * 60000 * (done + i)) / count : Date.now()
      ).toISOString();
      const joiner = makeJoiner({
        protestId,
        cc,
        gender: weightedPick(GENDER_WEIGHTS),
        ageBand: weightedPick(AGE_WEIGHTS),
        at,
        runId,
      });
      if (!joiner) continue;
      addInjected(protestId, joiner);
      written += 1;
    }
    done += size;
    if (written && typeof options.onProgress === 'function') {
      options.onProgress({ done: Math.min(done, count), total: count });
    }
    // Yield so live SSE traffic keeps flushing during large runs.
    await new Promise((resolve) => setImmediate(resolve));
  }

  flushSave();
  return { injected: done, total: getStats(protestId).total, runId };
}

/**
 * Distributed test: guarantee the same number of joiners in every country and
 * territory we support, so the map, country panel and demographic breakdowns all
 * have data in every region before a real campaign starts.
 */
export async function injectWorldwide(protestId, { perCountry = 25, countries } = {}) {
  const targets = countries && countries.length
    ? countries.map((c) => String(c).toUpperCase())
    : weights().map(([cc]) => cc);
  const per = Math.max(1, Math.min(5000, Number(perCountry) || 25));
  const runId = crypto.randomBytes(4).toString('hex');
  const emptyCountries = [];

  for (const cc of targets) {
    if (!cityWeights(cc).length) {
      emptyCountries.push(cc);
      continue;
    }
    for (let i = 0; i < per; i += 1) {
      const joiner = makeJoiner({
        protestId,
        cc,
        gender: weightedPick(GENDER_WEIGHTS),
        ageBand: weightedPick(AGE_WEIGHTS),
        at: new Date(Date.now() - randomInt(0, 30 * 60 * 1000)).toISOString(),
        runId,
      });
      if (joiner) addInjected(protestId, joiner);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  flushSave();
  return {
    injected: (targets.length - emptyCountries.length) * per,
    countries: targets.length - emptyCountries.length,
    skipped: emptyCountries,
    total: getStats(protestId).total,
  };
}

/** Small, realistic "warming up" run used by the seed script. */
export async function injectWarmup(protestId, count = 250) {
  return injectParticipants(protestId, { count, spreadMinutes: 120, batch: 500 });
}

export const injectionMeta = () => ({
  genders: GENDERS,
  ageBands: AGE_BANDS,
  countriesAvailable: weights().length,
  geo: geodbStats(),
});
