import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { ProtocolError, assertPeacefulLanguage } from './protocol.js';
import { buildJoinerIdentity } from './pseudonym.js';
import { getCity, getCountry } from './geo.js';

/**
 * Storage.
 *
 * Protests and their join counts are kept in a single JSON document because the
 * only things we persist about a participant are: generated name, age band,
 * gender, and the country/region/city they are counted in. Nothing there needs
 * a relational database, and a single file makes "no personal data" auditable.
 */

const DB_FILE = path.join(config.varDir, 'db.json');

const emptyDb = () => ({
  version: 1,
  createdAt: new Date().toISOString(),
  protests: {},
  joiners: {}, // protestId -> { anonId: joiner }  (real participants only)
  // Injected test participants are stored as aggregate rows rather than individual
  // records: identical country/city/gender/age/channel/minute combinations collapse
  // into one counted row, which keeps repeated test runs cheap.
  injected: {}, // protestId -> [ row ]
  pairingCodes: {}, // code -> { protestId, createdAt, expiresAt, uses }
  reports: [],
  physicalRequests: [],
  verifications: [],
  audit: [],
});

let db = emptyDb();
let saveTimer = null;
let saving = false;

/** protestId -> Map(rowKey -> aggregate row). Rehydrated from db.injected. */
const injectedAgg = new Map();

const injectedKey = (row) => `${row.country}|${row.cityId || row.city || ''}`;

function loadInjectedAgg() {
  injectedAgg.clear();
  for (const [protestId, rows] of Object.entries(db.injected || {})) {
    const map = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = normalizeInjectedRow(raw);
      const key = injectedKey(row);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, row);
        continue;
      }
      mergeInjectedRows(existing, row);
    }
    injectedAgg.set(protestId, map);
  }
}

/** Accept both the current nested shape and the older flat per-participant shape. */
function normalizeInjectedRow(raw) {
  if (raw && raw.genders && raw.ages) {
    return {
      ...raw,
      count: raw.count || 1,
      channels: raw.channels || {},
      minutes: raw.minutes || {},
      firstAt: raw.firstAt || raw.lastAt || new Date().toISOString(),
      lastAt: raw.lastAt || raw.firstAt || new Date().toISOString(),
    };
  }
  const at = String(raw.at || new Date().toISOString());
  return {
    country: raw.country,
    cityId: raw.cityId || '',
    city: raw.city || '',
    region: raw.region || '',
    continent: raw.continent || 'Other',
    count: raw.count || 1,
    genders: raw.gender ? { [raw.gender]: raw.count || 1 } : {},
    ages: raw.ageBand ? { [raw.ageBand]: raw.count || 1 } : {},
    channels: raw.channel ? { [raw.channel]: raw.count || 1 } : {},
    minutes: { [at.slice(0, 16)]: raw.count || 1 },
    firstAt: at,
    lastAt: at,
  };
}

function mergeInjectedRows(target, source) {
  target.count += source.count || 1;
  for (const dim of ['genders', 'ages', 'channels', 'minutes']) {
    target[dim] = target[dim] || {};
    for (const [key, count] of Object.entries(source[dim] || {})) {
      target[dim][key] = (target[dim][key] || 0) + count;
    }
  }
  if (source.firstAt < target.firstAt) target.firstAt = source.firstAt;
  if (source.lastAt > target.lastAt) target.lastAt = source.lastAt;
}

function flushInjectedAgg() {
  db.injected = {};
  for (const [protestId, map] of injectedAgg) {
    if (map.size) db.injected[protestId] = [...map.values()];
  }
}

function ensureDir() {
  fs.mkdirSync(config.varDir, { recursive: true });
}

export function loadDb() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    db = emptyDb();
    loadInjectedAgg();
    saveNow();
    return db;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = { ...emptyDb(), ...parsed };
    loadInjectedAgg();
  } catch (err) {
    // Never lose data silently: keep a copy of the unreadable file and start clean.
    const backup = `${DB_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(DB_FILE, backup);
    } catch {
      /* ignore */
    }
    db = emptyDb();
    loadInjectedAgg();
    saveNow();
  }
  return db;
}

export function getDb() {
  return db;
}

function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function saveNow() {
  ensureDir();
  flushInjectedAgg();
  writeFileAtomic(DB_FILE, JSON.stringify(db));
}

export function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saving) return;
    saving = true;
    try {
      saveNow();
    } finally {
      saving = false;
    }
  }, 250);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** Debounced save used by bulk paths (test injection) — coalesces to one write. */
export function saveSoon(delayMs = 5000) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saving) return;
    saving = true;
    try {
      saveNow();
    } finally {
      saving = false;
    }
  }, delayMs);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

export function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'protest';

const randomCode = (length = 6) => {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY3456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

export function uniqueProtestId(headline) {
  const base = slugify(headline);
  let candidate = base;
  let n = 2;
  while (db.protests[candidate]) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function audit(action, payload = {}) {
  db.audit.unshift({ action, at: new Date().toISOString(), ...payload });
  db.audit = db.audit.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Protests
// ---------------------------------------------------------------------------

export function protestPhase(protest, now = Date.now()) {
  if (!protest) return 'unknown';
  if (protest.status === 'cancelled') return 'cancelled';
  if (protest.status === 'ended') return 'ended';
  if (protest.startsAt && now < Date.parse(protest.startsAt)) return 'upcoming';
  if (protest.endsAt && now > Date.parse(protest.endsAt)) return 'ended';
  return 'live';
}

export function createProtest(input = {}) {
  const headline = String(input.headline || '').trim();
  const reason = String(input.reason || '').trim();
  if (headline.length < 8) {
    throw new ProtocolError('Give the protest a headline of at least 8 characters.', 'invalid_headline');
  }
  if (headline.length > 140) {
    throw new ProtocolError('Headline must be 140 characters or fewer.', 'invalid_headline');
  }
  if (reason.length < 20) {
    throw new ProtocolError('Explain the reason in at least 20 characters.', 'invalid_reason');
  }
  if (reason.length > 4000) {
    throw new ProtocolError('Reason must be 4000 characters or fewer.', 'invalid_reason');
  }

  // Protocol article 1 + 8: the platform refuses to publish a call to violence.
  assertPeacefulLanguage(headline, reason, input.asks || '', input.category || '');

  const id = String(input.id || '').trim() || uniqueProtestId(headline);
  if (!/^[a-z0-9-]{3,80}$/.test(id)) {
    throw new ProtocolError('Protest id must be lowercase letters, numbers and dashes.', 'invalid_id');
  }
  if (db.protests[id]) {
    throw new ProtocolError('A protest with that id already exists.', 'duplicate_id');
  }

  const now = Date.now();
  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date(now);
  const endsAt = input.endsAt
    ? new Date(input.endsAt)
    : new Date(startsAt.getTime() + 1000 * 60 * 60 * 24 * 7);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new ProtocolError('Start and end times must be valid dates.', 'invalid_dates');
  }
  if (endsAt <= startsAt) {
    throw new ProtocolError('The protest must end after it starts.', 'invalid_dates');
  }

  const protest = {
    id,
    headline,
    reason,
    asks: String(input.asks || '').trim().slice(0, 2000),
    category: String(input.category || 'general').trim().slice(0, 60),
    targetJoiners: Math.max(1, Math.min(config.maxJoinersPerProtest, Number(input.targetJoiners) || 100000)),
    protocolVersion: config.protocolVersion,
    protocolHash: null, // filled by caller with PROTOCOL_HASH
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: 'scheduled',
    timezoneNote: String(input.timezoneNote || '').trim().slice(0, 120),
    youtube: {
      channelUrl: input.youtube?.channelUrl || config.youtubeChannelUrl,
      videoId: input.youtube?.videoId ? String(input.youtube.videoId).trim() : '',
      live: Boolean(input.youtube?.live),
    },
    featured: Boolean(input.featured),
    createdBy: String(input.createdBy || 'platform').slice(0, 80),
    createdAt: new Date().toISOString(),
    injected: 0,
    pairingCode: randomCode(6),
    stats: null,
  };

  db.protests[id] = protest;
  db.joiners[id] = {};
  statsCache[id] = freshStats();
  audit('protest.created', { id, headline });
  scheduleSave();
  return protest;
}

export function listProtests({ includeEnded = true } = {}) {
  return Object.values(db.protests)
    .filter((p) => includeEnded || protestPhase(p) !== 'ended')
    .sort((a, b) => {
      const phaseRank = { live: 0, upcoming: 1, ended: 2, cancelled: 3 };
      const diff = phaseRank[protestPhase(a)] - phaseRank[protestPhase(b)];
      if (diff !== 0) return diff;
      return Date.parse(b.startsAt) - Date.parse(a.startsAt);
    })
    .map((p) => serializeProtest(p));
}

export function getProtest(id) {
  return db.protests[String(id || '')] || null;
}

export function updateProtest(id, patch = {}) {
  const protest = getProtest(id);
  if (!protest) throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });
  if (patch.headline || patch.reason) {
    assertPeacefulLanguage(patch.headline || '', patch.reason || '');
  }
  const editable = ['headline', 'reason', 'asks', 'targetJoiners', 'startsAt', 'endsAt', 'status', 'featured'];
  for (const key of editable) {
    if (patch[key] === undefined) continue;
    if (key === 'targetJoiners') {
      protest.targetJoiners = Math.max(1, Math.min(config.maxJoinersPerProtest, Number(patch[key]) || 1));
    } else if (key === 'featured') {
      protest.featured = Boolean(patch[key]);
    } else if (key === 'status') {
      if (!['scheduled', 'ended', 'cancelled', 'live'].includes(patch[key])) {
        throw new ProtocolError('Unknown protest status.', 'invalid_status');
      }
      protest.status = patch[key];
    } else {
      protest[key] = String(patch[key]);
    }
  }
  if (patch.youtube) {
    protest.youtube = { ...protest.youtube, ...patch.youtube };
  }
  audit('protest.updated', { id, keys: Object.keys(patch) });
  scheduleSave();
  return protest;
}

export function endProtest(id) {
  const protest = getProtest(id);
  if (!protest) throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });
  protest.status = 'ended';
  protest.endedAt = new Date().toISOString();
  audit('protest.ended', { id });
  scheduleSave();
  return protest;
}

export function deleteProtest(id) {
  const protest = getProtest(id);
  if (!protest) throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });
  delete db.protests[id];
  delete db.joiners[id];
  delete db.injected[id];
  injectedAgg.delete(id);
  delete statsCache[id];
  audit('protest.deleted', { id });
  scheduleSave();
  return protest;
}

export function serializeProtest(protest, { withKpi = false } = {}) {
  // A cheap summary is always attached so list views never need the full KPI
  // payload; the full breakdown is opt-in per protest.
  const stats = statsCache[protest.id] || rebuildStats(protest.id);
  const totals = {
    total: stats.total,
    real: stats.real,
    injected: stats.injected,
    countries: Object.keys(stats.countries).length,
    cities: Object.keys(stats.cities).length,
    regions: Object.keys(stats.regions).length,
    progress: protest.targetJoiners
      ? Math.min(100, Math.round((stats.total / protest.targetJoiners) * 1000) / 10)
      : 0,
  };

  return {
    id: protest.id,
    headline: protest.headline,
    reason: protest.reason,
    asks: protest.asks,
    category: protest.category,
    targetJoiners: protest.targetJoiners,
    protocolVersion: protest.protocolVersion,
    startsAt: protest.startsAt,
    endsAt: protest.endsAt,
    phase: protestPhase(protest),
    status: protest.status,
    youtube: protest.youtube,
    featured: protest.featured,
    createdAt: protest.createdAt,
    endedAt: protest.endedAt || null,
    pairingCode: protest.pairingCode,
    totals,
    kpi: withKpi ? buildKpi(protest.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

function freshStats() {
  return {
    total: 0,
    real: 0,
    injected: 0,
    countries: {},
    continents: {},
    cities: {},
    regions: {},
    genders: {},
    ages: {},
    channels: {},
    hours: {},
    minutes: {},
    firstJoinAt: null,
    lastJoinAt: null,
    injectedByCountry: {},
    injectedByCity: {},
    injectedByGender: {},
    injectedByAge: {},
  };
}

const statsCache = {};

export function getStats(protestId) {
  if (!statsCache[protestId]) statsCache[protestId] = freshStats();
  return statsCache[protestId];
}

/**
 * Fold one injected aggregate row into the stats: geography and totals once, then
 * each nested dimension counter (gender / age / channel / minute) separately.
 */
function applyInjectedDimensions(stats, row) {
  const total = row.count || 1;
  const cc = row.country || 'ZZ';
  const cityKey = row.cityId || `${cc}:${row.city || 'unknown'}`;

  stats.total += total;
  stats.injected += total;
  bump(stats.countries, cc, total);
  bump(stats.continents, row.continent || 'Other', total);
  bump(stats.cities, cityKey, total);
  bump(stats.regions, `${cc}|${row.region || ''}`, total);
  bump(stats.injectedByCountry, cc, total);
  bump(stats.injectedByCity, cityKey, total);

  for (const [gender, count] of Object.entries(row.genders || {})) {
    bump(stats.genders, gender, count);
    bump(stats.injectedByGender, gender, count);
  }
  for (const [ageBand, count] of Object.entries(row.ages || {})) {
    bump(stats.ages, ageBand, count);
    bump(stats.injectedByAge, ageBand, count);
  }
  for (const [channel, count] of Object.entries(row.channels || {})) {
    bump(stats.channels, channel, count);
  }
  for (const [minute, count] of Object.entries(row.minutes || {})) {
    bump(stats.minutes, minute, count);
  }
  if (row.firstAt && (!stats.firstJoinAt || row.firstAt < stats.firstJoinAt)) stats.firstJoinAt = row.firstAt;
  if (row.lastAt && (!stats.lastJoinAt || row.lastAt > stats.lastJoinAt)) stats.lastJoinAt = row.lastAt;
}

/** Rebuild counters from stored joiners (used on boot, after a wipe, or on repair). */
export function rebuildStats(protestId) {
  const stats = freshStats();
  const joiners = db.joiners[protestId] || {};
  for (const joiner of Object.values(joiners)) {
    applyToStats(stats, joiner);
  }
  for (const row of (injectedAgg.get(protestId) || new Map()).values()) {
    // Base row contributes geography + totals; nested counters contribute dimensions.
    applyInjectedDimensions(stats, row);
  }
  statsCache[protestId] = stats;
  return stats;
}

export function rebuildAllStats() {
  for (const id of Object.keys(db.protests)) rebuildStats(id);
}

function bump(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function applyToStats(stats, joiner, count = 1) {
  const cc = joiner.country || 'ZZ';
  const cityKey = joiner.cityId || `${cc}:${joiner.city || 'unknown'}`;
  stats.total += count;
  if (joiner.injected) stats.injected += count;
  else stats.real += count;

  bump(stats.countries, cc, count);
  bump(stats.continents, joiner.continent || 'Other', count);
  bump(stats.cities, cityKey, count);
  bump(stats.regions, `${cc}|${joiner.region || ''}`, count);
  if (joiner.gender) bump(stats.genders, joiner.gender, count);
  if (joiner.ageBand) bump(stats.ages, joiner.ageBand, count);
  if (joiner.channel) bump(stats.channels, joiner.channel, count);
  if (joiner.at) {
    bump(stats.hours, joiner.at.slice(0, 13), count);
    bump(stats.minutes, joiner.at.slice(0, 16), count);
  }

  if (joiner.injected) {
    bump(stats.injectedByCountry, cc, count);
    bump(stats.injectedByCity, cityKey, count);
    if (joiner.gender) bump(stats.injectedByGender, joiner.gender, count);
    if (joiner.ageBand) bump(stats.injectedByAge, joiner.ageBand, count);
  }

  if (joiner.at) {
    if (!stats.firstJoinAt || joiner.at < stats.firstJoinAt) stats.firstJoinAt = joiner.at;
    if (!stats.lastJoinAt || joiner.at > stats.lastJoinAt) stats.lastJoinAt = joiner.at;
  }
}

export function joinProtest(protestId, payload = {}) {
  const protest = getProtest(protestId);
  if (!protest) throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });
  if (protestPhase(protest) === 'ended') {
    throw new ProtocolError('This protest has finished and is closed to new joiners.', 'protest_ended');
  }

  const deviceSeed = String(payload.deviceSeed || '').trim();
  if (deviceSeed.length < 8 || deviceSeed.length > 200) {
    throw new ProtocolError('A device credential is required to join.', 'invalid_device');
  }

  const identity = buildJoinerIdentity({ protestId: protest.id, deviceSeed });
  if (!db.joiners[protest.id]) db.joiners[protest.id] = {};
  const existing = db.joiners[protest.id][identity.anonId];
  if (existing) {
    return { joiner: existing, duplicate: true, protest };
  }

  const stats = getStats(protest.id);
  if (stats.total >= config.maxJoinersPerProtest) {
    throw new ProtocolError('This protest has reached its participant limit.', 'capacity');
  }

  const location = payload.location || {};
  const now = new Date();
  const joiner = {
    anonId: identity.anonId,
    name: identity.name,
    protestId: protest.id,
    ageBand: payload.ageBand,
    gender: payload.gender,
    country: location.country || 'ZZ',
    countryName: location.countryName || 'Unknown',
    continent: location.continent || 'Other',
    region: location.region || '',
    city: location.city || '',
    cityId: location.cityId || '',
    channel: payload.channel || 'web',
    injected: false,
    at: now.toISOString(),
  };

  db.joiners[protest.id][identity.anonId] = joiner;
  applyToStats(stats, joiner);
  scheduleSave();
  return { joiner, duplicate: false, protest };
}

/**
 * Add one injected (test) participant.
 *
 * Rows are aggregated per city, with per-dimension counters nested inside, so a
 * test run of any size costs roughly one row per city touched — not one row per
 * participant. Breakdowns (gender, age, channel, minute) are preserved exactly.
 */
export function addInjected(protestId, joiner) {
  const protest = getProtest(protestId);
  if (!protest) throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });

  const at = String(joiner.at || new Date().toISOString());
  const minute = at.slice(0, 16);
  const row = {
    country: joiner.country,
    cityId: joiner.cityId || '',
    city: joiner.city || '',
    region: joiner.region || '',
    continent: joiner.continent || 'Other',
    count: 1,
    genders: { [joiner.gender]: 1 },
    ages: { [joiner.ageBand]: 1 },
    channels: { [joiner.channel || 'web']: 1 },
    // Only the last 60 arrival minutes matter for the live velocity chart.
    minutes: { [minute]: 1 },
    firstAt: at,
    lastAt: at,
  };

  let map = injectedAgg.get(protestId);
  if (!map) {
    map = new Map();
    injectedAgg.set(protestId, map);
  }
  const key = injectedKey(row);
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.genders[joiner.gender] = (existing.genders[joiner.gender] || 0) + 1;
    existing.ages[joiner.ageBand] = (existing.ages[joiner.ageBand] || 0) + 1;
    const channel = joiner.channel || 'web';
    existing.channels[channel] = (existing.channels[channel] || 0) + 1;
    existing.minutes[minute] = (existing.minutes[minute] || 0) + 1;
    trimMinutes(existing.minutes, minute, 90);
    if (at < existing.firstAt) existing.firstAt = at;
    if (at > existing.lastAt) existing.lastAt = at;
  } else {
    map.set(key, row);
  }
  // Increment the live counters by exactly one participant, in every dimension.
  applyOneInjected(getStats(protestId), row, joiner, minute);
  // Persistence is deliberately lazy: a 200k-participant test run must not write
  // the state file 200k times. flushSave() is called once at the end of a batch.
  saveSoon();
  return row;
}

/** Live (incremental) fold of a single injected participant into the counters. */
function applyOneInjected(stats, row, joiner, minute) {
  const cc = row.country || 'ZZ';
  const cityKey = row.cityId || `${cc}:${row.city || 'unknown'}`;
  stats.total += 1;
  stats.injected += 1;
  bump(stats.countries, cc);
  bump(stats.continents, row.continent || 'Other');
  bump(stats.cities, cityKey);
  bump(stats.regions, `${cc}|${row.region || ''}`);
  bump(stats.injectedByCountry, cc);
  bump(stats.injectedByCity, cityKey);
  bump(stats.genders, joiner.gender);
  bump(stats.injectedByGender, joiner.gender);
  bump(stats.ages, joiner.ageBand);
  bump(stats.injectedByAge, joiner.ageBand);
  bump(stats.channels, joiner.channel || 'web');
  bump(stats.minutes, minute);
  const at = row.lastAt;
  if (!stats.firstJoinAt || row.firstAt < stats.firstJoinAt) stats.firstJoinAt = row.firstAt;
  if (!stats.lastJoinAt || at > stats.lastJoinAt) stats.lastJoinAt = at;
}

/** Keep only the newest N minute buckets on an aggregate row. */
function trimMinutes(minutes, currentMinute, keep) {
  const keys = Object.keys(minutes);
  if (keys.length <= keep) return;
  keys.sort();
  for (const key of keys.slice(0, keys.length - keep)) {
    if (key !== currentMinute) delete minutes[key];
  }
}

export function getJoiner(protestId, anonId) {
  return (db.joiners[protestId] || {})[anonId] || null;
}

export function listJoiners(protestId, { limit = 50, since } = {}) {
  const all = Object.values(db.joiners[protestId] || {});
  const filtered = since ? all.filter((j) => j.at > since) : all;
  return filtered.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

export function removeJoiner(protestId, anonId, reason = 'policy') {
  const joiners = db.joiners[protestId] || {};
  const joiner = joiners[anonId];
  if (!joiner) return null;
  delete joiners[anonId];
  rebuildStats(protestId);
  audit('joiner.removed', { protestId, anonId, reason });
  scheduleSave();
  return joiner;
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

export function buildKpi(protestId) {
  const protest = getProtest(protestId);
  if (!protest) return null;
  const stats = statsCache[protestId] ? statsCache[protestId] : rebuildStats(protestId);
  const total = stats.total;

  const countryMeta = {};
  for (const [cc, count] of Object.entries(stats.countries)) {
    const meta = getCountry(cc);
    countryMeta[cc] = {
      code: cc,
      name: meta?.name || cc,
      continent: meta?.continent || 'Other',
      lat: meta?.lat || null,
      lng: meta?.lng || null,
      count,
      real: count - (stats.injectedByCountry[cc] || 0),
      injected: stats.injectedByCountry[cc] || 0,
      share: total ? Math.round((count / total) * 1000) / 10 : 0,
    };
  }
  const countries = Object.values(countryMeta).sort((a, b) => b.count - a.count);

  const cities = Object.entries(stats.cities)
    .map(([key, count]) => {
      const city = cityInfo(key);
      return {
        key,
        name: city.name,
        region: city.region || '',
        country: city.cc,
        countryName: countryName(city.cc),
        count,
        injected: stats.injectedByCity[key] || 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  const regions = Object.entries(stats.regions)
    .map(([key, count]) => {
      const [cc, name] = key.split('|');
      return { name: name || 'Unspecified', country: cc, countryName: countryName(cc), count };
    })
    .sort((a, b) => b.count - a.count);

  const continents = Object.entries(stats.continents)
    .map(([name, count]) => ({ name, count, share: total ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  const genders = Object.entries(stats.genders)
    .map(([key, count]) => ({ key, count, share: total ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  const ages = Object.entries(stats.ages)
    .map(([key, count]) => ({ key, count, share: total ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => ageBandOrder(a.key) - ageBandOrder(b.key));

  const channels = Object.entries(stats.channels)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  // Growth window: usage over the last 5 and 60 minutes, and per-minute series.
  const now = Date.now();
  const minuteSeries = [];
  let last5 = 0;
  let last60 = 0;
  for (let i = 59; i >= 0; i -= 1) {
    const d = new Date(now - i * 60000);
    const key = d.toISOString().slice(0, 16);
    const count = stats.minutes[key] || 0;
    minuteSeries.push({ t: d.toISOString(), count });
    last60 += count;
    if (i < 5) last5 += count;
  }

  return {
    protestId: protest.id,
    updatedAt: new Date().toISOString(),
    total,
    real: stats.real,
    injected: stats.injected,
    target: protest.targetJoiners,
    progress: protest.targetJoiners
      ? Math.min(100, Math.round((total / protest.targetJoiners) * 1000) / 10)
      : 0,
    countries,
    countryCount: countries.length,
    cities: cities.slice(0, 40),
    cityCount: cities.length,
    regions: regions.slice(0, 30),
    regionCount: regions.length,
    continents,
    genders,
    ages,
    channels,
    velocity: { last5, last60, perMinute: Math.round((last5 / 5) * 10) / 10 },
    minuteSeries,
    firstJoinAt: stats.firstJoinAt,
    lastJoinAt: stats.lastJoinAt,
  };
}

const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const ageBandOrder = (band) => (AGE_ORDER.indexOf(band) === -1 ? 99 : AGE_ORDER.indexOf(band));

let geoCache = null;
function geoData() {
  if (!geoCache) {
    const file = path.join(config.dataDir, 'geo.json');
    geoCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return geoCache;
}

export function countryName(cc) {
  return getCountry(cc)?.name || cc;
}

export function continentOf(cc) {
  return getCountry(cc)?.continent || 'Other';
}

function cityInfo(key) {
  const city = getCity(key);
  if (city) return { name: city.name, cc: city.cc, region: city.region };
  const [cc, name] = String(key).split(':');
  return { name: name || 'Unknown', cc: cc || 'ZZ' };
}

// ---------------------------------------------------------------------------
// Pairing codes (offline / Bluetooth handshake)
// ---------------------------------------------------------------------------

export function issuePairingCode(protestId, { code, ttlMs, origin } = {}) {
  const protest = getProtest(protestId);
  if (!protest) throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });
  const value = String(code || randomCode(6)).toUpperCase();
  const now = Date.now();
  db.pairingCodes[value] = {
    code: value,
    protestId: protest.id,
    origin: origin || '',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (ttlMs || config.pairingCodeTtlMs)).toISOString(),
    uses: 0,
  };
  protest.pairingCode = value;
  scheduleSave();
  return db.pairingCodes[value];
}

export function resolvePairingCode(code) {
  const value = String(code || '').trim().toUpperCase();
  const entry = db.pairingCodes[value];
  if (!entry) return null;
  if (Date.parse(entry.expiresAt) < Date.now()) return { ...entry, expired: true };
  return entry;
}

export function countPairingUse(code) {
  const entry = db.pairingCodes[String(code || '').toUpperCase()];
  if (entry) {
    entry.uses += 1;
    scheduleSave();
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Reports (protocol breaches) and physical-presence requests
// ---------------------------------------------------------------------------

export function addReport(payload = {}) {
  const protestId = String(payload.protestId || '').trim();
  if (!getProtest(protestId)) {
    throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });
  }
  const detail = String(payload.detail || '').trim();
  if (detail.length < 10) {
    throw new ProtocolError('Describe the breach in at least 10 characters.', 'invalid_report');
  }
  const report = {
    id: crypto.randomUUID(),
    protestId,
    category: String(payload.category || 'other').slice(0, 60),
    detail: detail.slice(0, 2000),
    joinerName: payload.joinerName ? String(payload.joinerName).slice(0, 80) : '',
    status: 'open',
    at: new Date().toISOString(),
  };
  db.reports.unshift(report);
  db.reports = db.reports.slice(0, 2000);
  audit('report.created', { protestId, category: report.category });
  scheduleSave();
  return report;
}

export function listReports() {
  return db.reports;
}

export function addPhysicalRequest(payload = {}) {
  const protestId = String(payload.protestId || '').trim();
  if (!getProtest(protestId)) {
    throw new ProtocolError('Protest not found.', 'not_found', { status: 404 });
  }
  const request = {
    id: crypto.randomUUID(),
    protestId,
    name: String(payload.name || '').slice(0, 120),
    contact: String(payload.contact || '').slice(0, 160),
    country: String(payload.country || '').toUpperCase().slice(0, 2),
    city: String(payload.city || '').slice(0, 120),
    area: String(payload.area || '').slice(0, 160),
    availability: String(payload.availability || '').slice(0, 300),
    verificationStatus: 'pending',
    at: new Date().toISOString(),
  };
  db.physicalRequests.unshift(request);
  audit('physical.requested', { protestId, country: request.country });
  scheduleSave();
  return request;
}

export function listPhysicalRequests(protestId) {
  const all = db.physicalRequests;
  return protestId ? all.filter((r) => r.protestId === protestId) : all;
}

export function addVerification(payload = {}) {
  const record = {
    id: crypto.randomUUID(),
    status: 'pending',
    at: new Date().toISOString(),
    ...payload,
  };
  db.verifications.unshift(record);
  audit('verification.created', { id: record.id });
  scheduleSave();
  return record;
}

export function listVerifications() {
  return db.verifications;
}

// ---------------------------------------------------------------------------
// Test data / reset
// ---------------------------------------------------------------------------

export function clearInjections(protestId) {
  const ids = protestId
    ? [protestId]
    : [...new Set([...injectedAgg.keys(), ...Object.keys(db.joiners)])];
  let removed = 0;
  for (const id of ids) {
    const map = injectedAgg.get(id);
    if (map) {
      for (const row of map.values()) removed += row.count || 1;
      map.clear();
      injectedAgg.delete(id);
    }
    // Tolerate legacy per-record injected joiners from older state files.
    const joiners = db.joiners[id] || {};
    for (const [anonId, joiner] of Object.entries(joiners)) {
      if (joiner.injected) {
        delete joiners[anonId];
        removed += 1;
      }
    }
    rebuildStats(id);
  }
  audit('injections.cleared', { protestId: protestId || 'all', removed });
  saveNow();
  return removed;
}

export function resetAll({ keepProtests = false } = {}) {
  const protests = keepProtests ? db.protests : {};
  db = emptyDb();
  db.protests = protests;
  db.joiners = {};
  for (const id of Object.keys(protests)) db.joiners[id] = {};
  db.injected = {};
  injectedAgg.clear();
  for (const id of Object.keys(statsCache)) delete statsCache[id];
  rebuildAllStats();
  audit('platform.reset', { keepProtests });
  flushSave();
  return db;
}

export function auditLog() {
  return db.audit;
}
