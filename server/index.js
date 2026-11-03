import config from './config.js';
import app from './app.js';
import * as store from './lib/store.js';
import { PROTOCOL, PROTOCOL_HASH } from './lib/protocol.js';
import { geodbStats } from './lib/geo.js';

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
  console.log('');
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, saving state...`);
  try {
    store.flushSave();
  } catch (err) {
    console.error('Failed to persist state on shutdown:', err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
