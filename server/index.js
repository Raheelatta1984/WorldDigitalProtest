import config from './config.js';
import app from './app.js';
import * as store from './lib/store.js';
import { PROTOCOL, PROTOCOL_HASH } from './lib/protocol.js';
import { geodbStats } from './lib/geo.js';
import { resumeBroadcasts, stopAllBroadcasts } from './lib/broadcast.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = app.listen(config.port, config.host, () => {
  const geo = geodbStats();
  console.log('');
  console.log('  World Digital Protest');
  console.log(`  listening on http://${config.host}:${config.port}`);
  console.log(`  protocol ${PROTOCOL.version} (${PROTOCOL_HASH.slice(0, 12)})`);
  console.log(`  geo: ${geo.cities.toLocaleString()} areas in ${geo.countries} countries`);
  console.log(`  test injection: ${config.enableTestInjection ? 'enabled' : 'disabled'}`);
  console.log(`  direct broadcast: ${config.broadcastEnabled ? 'available' : 'disabled'}`);
  const resumed = resumeBroadcasts();
  if (resumed.length) console.log(`  resumes: ${resumed.join(', ')}`);
  console.log('');
});

const shutdown = async (signal) => {
  console.log(`\n${signal} received, stopping broadcasts and saving state...`);
  try {
    // Let ffmpeg flush and close its RTMP session before the process goes away,
    // otherwise YouTube shows a dropped stream instead of a clean end.
    await stopAllBroadcasts();
  } catch (err) {
    console.error('Failed to stop broadcasts cleanly:', err.message);
  }
  try {
    store.flushSave();
  } catch (err) {
    console.error('Failed to persist state on shutdown:', err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
