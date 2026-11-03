/**
 * Wipes local application state (protests, joiners, codes, reports).
 * Keeps the built geo dataset intact.
 *
 * Run: npm run reset
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../server/config.js';

const file = path.join(config.varDir, 'db.json');
if (fs.existsSync(file)) {
  fs.rmSync(file);
  console.log(`Removed ${file}`);
} else {
  console.log('Nothing to reset — no state file exists.');
}
