/**
 * Seeds the platform with sample protests so the dashboards, the KPI map and the
 * test-injection tooling can be validated immediately.
 *
 * Run: npm run seed            (idempotent: existing protests are left alone)
 *      npm run seed -- --reset  (wipe joiners and reseed)
 */
import { config } from '../server/config.js';
import * as store from '../server/lib/store.js';
import { PROTOCOL_HASH } from '../server/lib/protocol.js';
import { injectParticipants, injectWorldwide } from '../server/lib/injector.js';

const now = Date.now();
const hours = (n) => new Date(now + n * 3600 * 1000).toISOString();

const PROTESTS = [
  {
    id: 'climate-clock',
    headline: 'Climate Clock: every country, one deadline',
    reason:
      'The climate deadline is the same in every country: our remaining carbon budget runs out on one shared calendar. ' +
      'Communities on every continent are already paying for emissions they did not produce. This protest asks governments ' +
      'to publish a dated, verifiable plan to stay inside 1.5 degrees before the next global summit closes.',
    asks:
      '1. Publish a dated national decarbonisation plan before the next summit.\n' +
      '2. Fund climate adaptation in the countries bearing the highest loss.\n' +
      '3. Report progress every quarter in public, in one comparable format.',
    category: 'climate',
    targetJoiners: 1000000,
    startsAt: hours(-6),
    endsAt: hours(66),
    featured: true,
    youtube: { videoId: '', live: false },
    seed: { count: 450000, spreadMinutes: 360, worldwide: 12 },
  },
  {
    id: 'open-doors-education',
    headline: 'Open Doors: education is not a privilege',
    reason:
      'In every city there are children out of school and young people priced out of study. The barrier is rarely ability; ' +
      'it is cost, distance and paperwork. This protest calls for free, accessible schooling and a transparent scholarship ' +
      'system in every country, so opportunity stops being decided by postcode.',
    asks:
      '1. Guarantee free primary and secondary schooling everywhere.\n' +
      '2. Make scholarship criteria public, uniform and appealable.\n' +
      '3. Publish the number of children out of school, by district, every year.',
    category: 'education',
    targetJoiners: 500000,
    startsAt: hours(-30),
    endsAt: hours(114),
    youtube: { videoId: '', live: false },
    seed: { count: 62000, spreadMinutes: 1440, worldwide: 6 },
  },
  {
    id: 'peaceful-streets',
    headline: 'Peaceful Streets: 24 hours of strictly non-violent action',
    reason:
      'A protest of millions that never gathers still needs a standard. On this date, participants in every country take part ' +
      'peacefully for 24 hours: no confrontation, no confrontation-chasing, no violence of any kind. We show that turnout and ' +
      'discipline are not opposites, and that the strongest signal is a peaceful one.',
    asks:
      '1. Participants in every timezone join at the same clock moment.\n' +
      '2. Every participant accepts the same protocol before counting.\n' +
      '3. Public count reported live, in full, with no inflation.',
    category: 'civic',
    targetJoiners: 250000,
    startsAt: hours(12),
    endsAt: hours(36),
    youtube: { videoId: '', live: false },
    seed: { count: 900, spreadMinutes: 30 },
  },
  {
    id: 'open-data-water',
    headline: 'Open the data on drinking water',
    reason:
      'Households everywhere are asked to trust water reporting they cannot see. This protest asks for the same three datasets ' +
      'to be published openly in every country: quality test results, outage records, and infrastructure spending. Sunlight on ' +
      'the data is the cheapest public health measure available.',
    asks:
      '1. Publish water quality results by district, monthly.\n' +
      '2. Publish outage records in a machine-readable format.\n' +
      '3. Publish infrastructure spend down to contract level.',
    category: 'transparency',
    targetJoiners: 150000,
    startsAt: hours(-240),
    endsAt: hours(-24),
    status: 'ended',
    seed: { count: 41000, spreadMinutes: 1080 },
  },
];

async function main() {
  const reset = process.argv.includes('--reset');
  store.loadDb();

  if (reset) {
    store.resetAll({ keepProtests: false });
    console.log('Reset: all protests and joiners cleared.');
  }

  let created = 0;
  for (const seed of PROTESTS) {
    const { seed: injection, ...data } = seed;
    const existing = store.getProtest(data.id);
    if (existing) {
      console.log(`= ${data.id} (already present, left as is)`);
      continue;
    }
    const protest = store.createProtest({ ...data, protocolHash: PROTOCOL_HASH });
    protest.protocolHash = PROTOCOL_HASH;
    if (data.status) protest.status = data.status;
    if (data.featured) protest.featured = true;
    created += 1;
    console.log(`+ ${protest.id}  "${protest.headline}"`);
  }

  store.flushSave();

  // Pre-populate a labelled global baseline so every panel has data to render and
  // the map shows genuine worldwide coverage before a single real join arrives.
  for (const seed of PROTESTS) {
    const { seed: injection } = seed;
    if (!injection) continue;
    if (store.getStats(seed.id).total > 0) continue;

    // Guarantee every supported country appears at least a few times.
    if (injection.worldwide) {
      const spread = await injectWorldwide(seed.id, { perCountry: injection.worldwide });
      console.log(`  ${seed.id}: ${spread.countries} countries seeded`);
    }

    const result = await injectParticipants(seed.id, {
      count: injection.count,
      spreadMinutes: injection.spreadMinutes,
    });
    console.log(
      `  injected ${result.injected.toLocaleString()} test participants into ${seed.id} (${
        injection.worldwide ? 'plus global coverage' : 'weighted by population'
      }; counted separately from real joins)`
    );
  }

  store.flushSave();
  console.log(`\nSeeded ${created} new protest(s). Data directory: ${config.varDir}`);
  console.log('Start the app with: npm start');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
