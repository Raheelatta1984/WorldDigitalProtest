#!/usr/bin/env node
/**
 * End-to-end broadcast check.
 *
 * Starts ffmpeg in RTMP *listener* mode as a stand-in ingest (a real RTMP server
 * speaking the real protocol), points a live Broadcast at it, then decodes what
 * arrived to prove video actually flowed. No YouTube credentials are needed, so
 * this can run in CI.
 *
 *   node scripts/broadcast-check.js [protestId]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
process.chdir(root);
process.env.WDP_SILENT = '1';

const port = Number(process.env.CHECK_PORT || 24450);
const key = 'check-0000-test-key';
const output = path.join(os.tmpdir(), `wdp-broadcast-check-${Date.now()}.flv`);

const { resolveFfmpeg, startBroadcast, stopBroadcast, broadcastStatus } = await import(
  '../server/lib/broadcast.js'
);
const store = await import('../server/lib/store.js');

const ffmpeg = resolveFfmpeg();
const protestId = process.argv[2] || 'climate-clock';

store.loadDb();
const protest = store.getProtest(protestId);
if (!protest) {
  console.error(`No protest "${protestId}". Run: npm run seed`);
  process.exit(1);
}

// 1. Ingest stand-in: ffmpeg listening for an RTMP publish, copying to a file.
const listener = spawn(
  ffmpeg,
  ['-hide_banner', '-loglevel', 'warning', '-y', '-listen', '1',
   '-f', 'flv', '-i', `rtmp://127.0.0.1:${port}/live2/${key}`,
   '-c', 'copy', '-f', 'flv', output],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);
let listenerLog = '';
listener.stderr.on('data', (chunk) => {
  listenerLog += chunk.toString();
});

await new Promise((resolve) => setTimeout(resolve, 800));

// 2. Point the protest at it and go live.
store.updateProtest(protestId, {
  broadcast: { ...(protest.broadcast || {}), ingest: `rtmp://127.0.0.1:${port}/live2/${key}`, fps: 2 },
});
const { setStreamKey } = await import('../server/lib/broadcast.js');
setStreamKey(protestId, key);

console.log(`Pushing "${protestId}" to rtmp://127.0.0.1:${port}/live2/<key> ...`);
startBroadcast(protestId, { fps: 2, bitrateKbps: 2500 });

// Watch for the moment video actually reaches the ingest.
const deadline = Date.now() + Number(process.env.CHECK_SECONDS || 25) * 1000;
let sawLive = false;
while (Date.now() < deadline) {
  const status = broadcastStatus(protestId);
  if (status.state === 'live' && status.frames >= 6) {
    sawLive = true;
    break;
  }
  if (status.state === 'error') break;
  await new Promise((resolve) => setTimeout(resolve, 400));
}

const status = broadcastStatus(protestId);
console.log(`state=${status.state} frames=${status.frames} MB=${status.megabytes}`);
if (status.error) console.log(`error: ${status.error}`);
if (status.log.length) console.log(status.log.slice(-6).join('\n'));

await stopBroadcast(protestId);
listener.kill('SIGINT');
await new Promise((resolve) => setTimeout(resolve, 1200));

// 3. Decode what was received, to prove the stream carried real video.
let probed = null;
if (fs.existsSync(output) && fs.statSync(output).size > 2000) {
  const probe = spawn(ffmpeg, ['-hide_banner', '-i', output, '-f', 'null', '-'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  probe.stderr.on('data', (chunk) => {
    log += chunk.toString();
  });
  await new Promise((resolve) => probe.on('close', resolve));
  const duration = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(log);
  const video = /Stream #0:0.*Video: (\w+)/.exec(log);
  const audio = /Stream #0:1.*Audio: (\w+)/.exec(log);
  probed = {
    bytes: fs.statSync(output).size,
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    video: video ? video[1] : null,
    audio: audio ? audio[1] : null,
  };
}

// Restore the protest so the check leaves no state behind.
store.updateProtest(protestId, { broadcast: { ...(store.getProtest(protestId).broadcast || {}), ingest: '' } });
store.flushSave();
try {
  fs.unlinkSync(output);
} catch {
  /* ignore */
}

const problems = [];
if (!sawLive) problems.push('broadcast never reached the live state');
if (!probed) problems.push('the ingest received no usable stream');
else {
  if (probed.video !== 'h264') problems.push(`expected h264 video, got ${probed.video}`);
  if (!probed.audio) problems.push('stream carried no audio track');
  if (probed.seconds < 1) problems.push('stream was shorter than a second');
}
if (listenerLog.includes('Input/output error')) problems.push('ingest reported an I/O error');

if (problems.length) {
  console.error('\nBroadcast check FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  if (listenerLog) console.error(`\nIngest log:\n${listenerLog.slice(-1500)}`);
  process.exit(1);
}

console.log(
  `\nBroadcast check passed: ${probed.bytes.toLocaleString()} bytes, ` +
    `${probed.seconds.toFixed(1)}s of ${probed.video}/${probed.audio} received by the ingest.`
);
process.exit(0);
