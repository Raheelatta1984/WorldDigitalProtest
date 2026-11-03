#!/usr/bin/env node
/**
 * Render one broadcast frame to a file.
 *
 * Useful for checking the layout and fonts without going live, and for
 * generating a static thumbnail for a YouTube event.
 *
 *   node scripts/frame.js [protestId] [--jpeg] [--out file]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(here, '..'));
process.env.WDP_SILENT = '1';

const { renderFrame, fontInfo, frameSize } = await import('../server/lib/broadcast-render.js');
const store = await import('../server/lib/store.js');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const outIndex = args.indexOf('--out');

store.loadDb();
const protestId = positional[0] || 'climate-clock';
const protest = store.getProtest(protestId);
if (!protest) {
  console.error(`No protest "${protestId}".`);
  const available = store.listProtests().map((p) => p.id);
  if (available.length) console.error(`Available: ${available.join(', ')}`);
  else console.error('The database is empty. Run: npm run seed');
  process.exit(1);
}

const format = flags.has('--jpeg') ? 'jpeg' : 'png';
const file = await renderFrame({
  protest: store.serializeProtest(protest),
  kpi: store.buildKpi(protestId),
  recent: store.listJoiners(protestId, { limit: 5 }),
  format,
});

const target = outIndex !== -1 ? path.resolve(args[outIndex + 1]) : path.join('var', `frame-${protestId}.${format === 'jpeg' ? 'jpg' : 'png'}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(file, target);
fs.unlinkSync(file);

const fonts = fontInfo();
console.log(`Rendered ${protestId} at ${frameSize.width}x${frameSize.height} -> ${target}`);
console.log(`Font: ${fonts.regular || 'NONE (set WDP_FONT_REGULAR)'}`);
if (!fonts.regular) process.exitCode = 1;
