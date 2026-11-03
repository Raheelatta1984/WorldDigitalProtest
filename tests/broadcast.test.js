/**
 * Broadcast tests.
 *
 * Two layers:
 *   1. unit tests for the renderer and ffmpeg command line (fast, no network)
 *   2. an end-to-end push against a real RTMP listener, which proves the whole
 *      chain (render -> raw frames -> libx264/aac -> RTMP) actually produces a
 *      playable stream. The listener is ffmpeg itself, so this is the real
 *      protocol, not a mock.
 *
 * YouTube credentials are never involved: the end-to-end test points the
 * protest at the local listener through the `broadcast.ingest` field.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-broadcast-'));
process.env.WDP_DATA_DIR = tmpDir;
process.env.WDP_SILENT = '1';
process.env.PORT = '0';
// Never let an accidental YouTube connection happen in a test run.
process.env.WDP_BROADCAST_AUTORESUME = 'false';

const store = await import('../server/lib/store.js');
const render = await import('../server/lib/broadcast-render.js');
const broadcast = await import('../server/lib/broadcast.js');

const FFMPEG = broadcast.resolveFfmpeg();
const hasFfmpeg = (() => {
  try {
    if (FFMPEG === 'ffmpeg') return true; // assume PATH is fine; spawn will tell us
    return fs.statSync(FFMPEG).isFile();
  } catch {
    return false;
  }
})();

const PROTEST_ID = 'broadcast-test';
const STREAM_KEY = 'test-stream-key-1234';
const PORT = 24490 + Math.floor(Math.random() * 40);

let protest;

before(() => {
  store.loadDb();
  protest = store.createProtest({
    id: PROTEST_ID,
    headline: 'A worldwide protest rendered on a server',
    reason:
      'This protest exists so the broadcast pipeline can be verified end to end without going anywhere near a real YouTube event.',
    targetJoiners: 5000,
  });
  for (let i = 0; i < 25; i += 1) {
    store.addInjected(PROTEST_ID, {
      country: ['US', 'IN', 'BR', 'DE', 'NG'][i % 5],
      city: `Test City ${i}`,
      age: 20 + i,
      gender: ['female', 'male', 'non-binary', 'undisclosed'][i % 4],
      channel: 'test',
    });
  }
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

test('frame renderer returns a full RGBA frame', async () => {
  const frame = await render.renderFrameRaw({
    protest: store.serializeProtest(protest),
    kpi: store.buildKpi(PROTEST_ID),
    recent: store.listJoiners(PROTEST_ID, { limit: 5 }),
  });
  assert.equal(frame.length, render.WIDTH * render.HEIGHT * 4);
  assert.equal(render.frameSize.width, 1920);
  assert.equal(render.frameSize.height, 1080);
  // The frame must not be a blank canvas: sample a slice of pixels.
  const nonZero = frame.subarray(0, 400_000).some((byte) => byte !== 0);
  assert.ok(nonZero, 'frame should contain drawn pixels');
});

test('frame renderer reports usable fonts', async () => {
  await render.ensureFonts();
  const info = render.fontInfo();
  if (!info.ready) {
    assert.fail(
      'No font available for broadcast rendering. Install DejaVu or set WDP_FONT_REGULAR.'
    );
  }
  assert.ok(info.regular);
});

test('repeated frames reuse the static layer and stay fast', async () => {
  const input = {
    protest: store.serializeProtest(protest),
    kpi: store.buildKpi(PROTEST_ID),
    recent: [],
  };
  await render.renderFrameRaw(input); // cold: builds the static layer
  const started = Date.now();
  for (let i = 0; i < 3; i += 1) await render.renderFrameRaw(input);
  const perFrame = (Date.now() - started) / 3;
  // One frame per second must fit comfortably; a regression here would make the
  // 1 fps push stutter on modest hardware.
  assert.ok(perFrame < 900, `warm frame took ${perFrame}ms, expected < 900ms`);
});

test('png preview renders to a file', async () => {
  const file = await render.renderFrame({
    protest: store.serializeProtest(protest),
    kpi: store.buildKpi(PROTEST_ID),
    recent: [],
    format: 'png',
  });
  assert.ok(fs.existsSync(file));
  assert.ok(fs.statSync(file).size > 10_000);
  // PNG signature
  const head = fs.readFileSync(file).subarray(0, 4);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47]);
  fs.unlinkSync(file);
});

// ---------------------------------------------------------------------------
// Stream keys
// ---------------------------------------------------------------------------

test('stream keys are stored server-side and only ever masked', () => {
  const saved = broadcast.setStreamKey(PROTEST_ID, STREAM_KEY);
  assert.equal(saved.hasKey, true);
  assert.ok(saved.hint.includes('••'));
  assert.ok(!saved.hint.includes(STREAM_KEY));

  assert.equal(broadcast.getStreamKey(PROTEST_ID), STREAM_KEY);
  const status = broadcast.broadcastStatus(PROTEST_ID);
  assert.equal(status.hasKey, true);
  assert.ok(!JSON.stringify(status).includes(STREAM_KEY), 'status must not leak the key');
  assert.ok(status.target.includes('<stream-key>'));
  assert.ok(status.target.startsWith('rtmps://a.rtmps.youtube.com'));
});

test('a malformed stream key is rejected', () => {
  assert.throws(() => broadcast.setStreamKey(PROTEST_ID, 'has spaces and $ymbols'), /stream key/i);
});

test('rotating the transport changes the ingest endpoint', () => {
  broadcast.saveBroadcastSettings(PROTEST_ID, { transport: 'rtmp' });
  assert.ok(broadcast.ingestUrlRedacted(PROTEST_ID).startsWith('rtmp://a.rtmp.youtube.com:1935'));
  broadcast.saveBroadcastSettings(PROTEST_ID, { transport: 'rtmps' });
  assert.ok(broadcast.ingestUrlRedacted(PROTEST_ID).startsWith('rtmps://a.rtmps.youtube.com:443'));
});

test('broadcast settings are clamped to safe values', () => {
  const saved = broadcast.saveBroadcastSettings(PROTEST_ID, { fps: 500, bitrateKbps: 999_999 });
  assert.ok(saved.fps <= 5);
  assert.ok(saved.bitrateKbps <= 12000);
});

// ---------------------------------------------------------------------------
// ffmpeg command
// ---------------------------------------------------------------------------

test('ffmpeg arguments target YouTube with an audio track', () => {
  const args = broadcast.buildFfmpegArgs({ protestId: PROTEST_ID, fps: 1 });
  const line = args.join(' ');
  assert.ok(line.includes('-f rawvideo'), 'frames arrive as raw video');
  assert.ok(line.includes('1920x1080'));
  assert.ok(line.includes('libx264'), 'video must be H.264 for YouTube');
  assert.ok(line.includes('yuv420p'), 'YouTube requires 4:2:0 chroma');
  assert.ok(line.includes('anullsrc'), 'stream must always carry audio');
  assert.ok(line.includes('-f flv'));
  assert.ok(line.endsWith(broadcast.ingestUrl(PROTEST_ID)));
  // GOP scales with frame rate so keyframes land about every 2 seconds.
  const gopIndex = args.indexOf('-g');
  assert.equal(Number(args[gopIndex + 1]), 2);
});

test('a custom ingest URL can be used and keeps the key out of logs', async () => {
  broadcast.saveBroadcastSettings(PROTEST_ID, { ingest: 'rtmp://127.0.0.1:1/live2/<key>' });
  assert.equal(broadcast.ingestUrl(PROTEST_ID), `rtmp://127.0.0.1:1/live2/${STREAM_KEY}`);
  // The redacted form must not contain the key itself.
  const redacted = broadcast.ingestUrlRedacted(PROTEST_ID);
  assert.ok(!redacted.includes(STREAM_KEY));
  broadcast.saveBroadcastSettings(PROTEST_ID, { ingest: '' });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test(
  'a broadcast pushes a playable H.264/AAC stream over RTMP',
  { skip: hasFfmpeg ? false : 'ffmpeg is not installed', timeout: 90_000 },
  async () => {
    const output = path.join(tmpDir, 'captured.flv');

    // Real RTMP ingest: ffmpeg listens for a publish and copies it to a file.
    const listener = spawn(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'warning', '-y', '-listen', '1',
        '-f', 'flv', '-i', `rtmp://127.0.0.1:${PORT}/live2/${STREAM_KEY}`,
        '-c', 'copy', '-f', 'flv', output,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    let listenerExit = null;
    listener.on('close', (code) => {
      listenerExit = code;
    });

    await new Promise((resolve) => setTimeout(resolve, 900));

    broadcast.saveBroadcastSettings(PROTEST_ID, {
      ingest: `rtmp://127.0.0.1:${PORT}/live2/${STREAM_KEY}`,
      fps: 2,
      bitrateKbps: 1500,
    });

    try {
      broadcast.startBroadcast(PROTEST_ID, { fps: 2, bitrateKbps: 1500 });

      let status = broadcast.broadcastStatus(PROTEST_ID);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        status = broadcast.broadcastStatus(PROTEST_ID);
        if (status.state === 'live' && status.frames >= 5) break;
        if (status.state === 'error') break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      assert.equal(status.state, 'live', `expected live, got ${status.state}: ${status.error || ''}`);
      assert.ok(status.frames >= 5, 'frames should have reached ffmpeg');
      assert.ok(status.megabytes > 0, 'encoded bytes should be counted');
      assert.equal(listenerExit, null, 'the ingest should still be receiving');

      await broadcast.stopBroadcast(PROTEST_ID);
      listener.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      assert.ok(fs.existsSync(output), 'the ingest should have written a file');
      assert.ok(fs.statSync(output).size > 5000, 'the captured stream is too small');

      // Decode the capture: this proves the bytes are a valid live stream.
      const probe = spawn(FFMPEG, ['-hide_banner', '-i', output, '-f', 'null', '-'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let log = '';
      probe.stderr.on('data', (chunk) => {
        log += chunk.toString();
      });
      await new Promise((resolve) => probe.on('close', resolve));

      assert.match(log, /Video: h264/i, 'stream must carry H.264 video');
      assert.match(log, /1920x1080/);
      assert.match(log, /Audio: aac/i, 'stream must carry AAC audio');
    } finally {
      if (listenerExit === null) listener.kill('SIGKILL');
      broadcast.saveBroadcastSettings(PROTEST_ID, { ingest: '' });
      await broadcast.stopBroadcast(PROTEST_ID);
    }
  }
);

test('starting without a stream key fails with a clear error', () => {
  broadcast.setStreamKey(PROTEST_ID, '');
  assert.throws(() => broadcast.startBroadcast(PROTEST_ID), /stream key/i);
});

test('broadcast health reports the encoder and fonts', () => {
  const health = broadcast.broadcastHealth();
  assert.equal(health.frame.width, 1920);
  assert.equal(health.frame.height, 1080);
  assert.ok(health.ffmpeg.path);
  assert.ok(health.ingest.rtmps.includes('a.rtmps.youtube.com'));
});
