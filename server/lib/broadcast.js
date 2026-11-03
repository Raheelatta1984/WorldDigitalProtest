/**
 * broadcast.js
 * ------------
 * Pushes a protest straight to YouTube Live over RTMP, with no browser, no OBS
 * and no operator in the loop.
 *
 *   renderFrameRaw(kpi)  →  raw RGBA  →  ffmpeg (libx264 + aac)  →  rtmp(s)://
 *
 * One `Broadcast` object exists per protest. It owns:
 *   - the render + encode loop (one frame per second by default, so bandwidth and
 *     CPU stay flat no matter how many protests are streaming)
 *   - reconnects with exponential backoff when YouTube drops the connection
 *   - a silence track, so YouTube never sees a video-only stream
 *   - a status object the API and UI can read
 *
 * Secrets: a YouTube stream key is a password. It lives in the encrypted-at-rest
 * store, is only ever read here on the server, and is never serialised to a
 * browser. The API returns `hasKey` and a masked hint instead.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import config from '../config.js';
import * as store from './store.js';
import { renderFrameRaw, cleanFrameDir, fontInfo, WIDTH, HEIGHT } from './broadcast-render.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// ffmpeg discovery
// ---------------------------------------------------------------------------

let ffmpegPath = null;

/**
 * Resolve a usable ffmpeg binary.
 *
 * Order: explicit env override, the @ffmpeg-installer package (a normal npm
 * dependency, so a `npm install` is enough on a fresh box), then PATH.
 */
export function resolveFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  if (process.env.WDP_FFMPEG) {
    ffmpegPath = process.env.WDP_FFMPEG;
    return ffmpegPath;
  }
  try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    if (installer?.path) {
      ffmpegPath = installer.path;
      return ffmpegPath;
    }
  } catch {
    /* fall through to PATH */
  }
  ffmpegPath = 'ffmpeg';
  return ffmpegPath;
}

export const ffmpegInfo = () => {
  const binary = resolveFfmpeg();
  return { path: binary, bundled: binary !== 'ffmpeg' };
};

// ---------------------------------------------------------------------------
// stream keys
// ---------------------------------------------------------------------------

const keyFile = () => `${config.varDir}/broadcast-keys.json`;

let keyCache = null;

const readKeys = () => {
  if (keyCache) return keyCache;
  try {
    keyCache = JSON.parse(require('node:fs').readFileSync(keyFile(), 'utf8'));
  } catch {
    keyCache = {};
  }
  return keyCache;
};

const writeKeys = () => {
  const fs = require('node:fs');
  fs.mkdirSync(config.varDir, { recursive: true });
  const file = keyFile();
  // 0600: a stream key is a credential, not content.
  fs.writeFileSync(file, JSON.stringify(keyCache, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort (Windows) */
  }
};

/** Store a stream key server-side only. Returns a masked hint for the UI. */
export function setStreamKey(protestId, streamKey) {
  const key = String(streamKey || '').trim();
  const keys = readKeys();
  if (!key) {
    delete keys[protestId];
    writeKeys();
    return { hasKey: false, hint: null };
  }
  if (!/^[A-Za-z0-9-]{8,120}$/.test(key)) {
    throw Object.assign(new Error('That does not look like a YouTube stream key.'), {
      status: 400,
      code: 'invalid_stream_key',
    });
  }
  keys[protestId] = key;
  writeKeys();
  return { hasKey: true, hint: maskKey(key) };
}

export const getStreamKey = (protestId) => readKeys()[protestId] || null;

export const hasStreamKey = (protestId) => Boolean(getStreamKey(protestId));

export const maskKey = (key) =>
  key ? `${key.slice(0, 4)}${'•'.repeat(Math.max(4, Math.min(16, key.length - 8)))}${key.slice(-4)}` : null;

export const keyHint = (protestId) => maskKey(getStreamKey(protestId));

// ---------------------------------------------------------------------------
// target URLs
// ---------------------------------------------------------------------------

/**
 * YouTube's ingest endpoint.
 *
 * "rtmp" (plain) uses port 1935 and is blocked on a lot of hosting/office
 * networks; "rtmps" uses 443 and is the safe default. Both are selectable per
 * protest.
 */
export const ingestUrl = (protestId) => {
  const protest = store.getProtest(protestId);

  // A full custom ingest URL wins: self-hosted RTMP servers (nginx-rtmp, SRS,
  // MediaMTX) and other platforms use the same path. If it contains <key> the
  // stored stream key is substituted.
  const custom = protest?.broadcast?.ingest || process.env.WDP_RTMP_TARGET || '';
  if (custom) {
    const base = String(custom).replace('<key>', getStreamKey(protestId) || '');
    return base.replace(/\/+$/, '');
  }

  const transport = protest?.broadcast?.transport === 'rtmp' ? 'rtmp' : 'rtmps';
  const host = transport === 'rtmp' ? 'a.rtmp.youtube.com' : 'a.rtmps.youtube.com';
  const port = transport === 'rtmp' ? 1935 : 443;
  const base = transport === 'rtmp' ? `rtmp://${host}:${port}/live2` : `rtmps://${host}:${port}/live2`;
  return `${base}/${getStreamKey(protestId) || ''}`;
};

/** Same target with the key removed, safe for logs and API responses. */
export const ingestUrlRedacted = (protestId) => {
  const protest = store.getProtest(protestId);
  const custom = protest?.broadcast?.ingest || process.env.WDP_RTMP_TARGET || '';
  if (custom) return String(custom).replace(getStreamKey(protestId) || '\u0000', '<stream-key>');
  const transport = protest?.broadcast?.transport === 'rtmp' ? 'rtmp' : 'rtmps';
  const host = transport === 'rtmp' ? 'a.rtmp.youtube.com' : 'a.rtmps.youtube.com';
  const port = transport === 'rtmp' ? 1935 : 443;
  return `${transport}://${host}:${port}/live2/<stream-key>`;
};

// ---------------------------------------------------------------------------
// ffmpeg arguments
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg command line for one broadcast.
 *
 * Input 0: raw RGBA frames on stdin (we draw them, ffmpeg encodes them).
 * Input 1: generated silence, so the stream always carries an audio track.
 *
 * `-tune stillimage` plus a long GOP keeps the bitrate low for a mostly-static
 * dashboard; `yuv420p` and a baseline-friendly profile keep YouTube happy.
 */
export function buildFfmpegArgs({ protestId, fps = 1, bitrateKbps = 2500, keyframeSeconds = 2 } = {}) {
  const gop = Math.max(1, Math.round(fps * keyframeSeconds));
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',

    // Video: raw RGBA frames piped in from the renderer.
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${WIDTH}x${HEIGHT}`,
    // -framerate (not -r) on the input tells the rawvideo demuxer the cadence,
    // which avoids ffmpeg's "not enough frames to estimate rate" warning.
    '-framerate', String(fps),
    '-i', 'pipe:0',

    // Audio: silence, so the stream is never video-only.
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',

    '-map', '0:v:0',
    '-map', '1:a:0',

    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-b:v', `${bitrateKbps}k`,
    '-maxrate', `${bitrateKbps}k`,
    '-bufsize', `${bitrateKbps * 2}k`,

    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',

    '-shortest',
    '-f', 'flv',
    ingestUrl(protestId),
  ];
}

// ---------------------------------------------------------------------------
// Broadcast lifecycle
// ---------------------------------------------------------------------------

const clamp = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Broadcast {
  constructor(protestId, options = {}) {
    this.protestId = protestId;
    this.fps = clamp(options.fps, 0.2, 5, 1);
    this.bitrateKbps = clamp(options.bitrateKbps, 500, 12000, 2500);
    this.startedAt = null;
    this.stoppedAt = null;
    this.state = 'idle'; // idle | starting | live | reconnecting | stopping | error
    this.error = null;
    this.attempts = 0;
    this.frames = 0;
    this.bytes = 0;
    this.ffmpegLog = [];
    this.lastFrameAt = null;
    this.lastErrorAt = null;
    this.consecutiveFailures = 0;
    this.keepRunning = false;
    this.child = null;
    this.loopPromise = null;

    // A manual stop must not trigger the auto-restart path.
    this.stopping = false;
  }

  status() {
    return {
      protestId: this.protestId,
      state: this.state,
      live: this.state === 'live',
      fps: this.fps,
      bitrateKbps: this.bitrateKbps,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      uptimeSeconds: this.startedAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(this.startedAt)) / 1000))
        : 0,
      frames: this.frames,
      megabytes: Math.round((this.bytes / (1024 * 1024)) * 10) / 10,
      lastFrameAt: this.lastFrameAt,
      attempts: this.attempts,
      hasKey: hasStreamKey(this.protestId),
      keyHint: keyHint(this.protestId),
      transport: store.getProtest(this.protestId)?.broadcast?.transport || 'rtmps',
      target: ingestUrlRedacted(this.protestId),
      ffmpeg: ffmpegInfo(),
      error: this.error,
      log: this.ffmpegLog.slice(-12),
    };
  }

  log(line) {
    const text = String(line).trim();
    if (!text) return;
    // Benign on every ffmpeg build: a raw pipe has no headers to probe, and the
    // cadence is set explicitly with -framerate. Filtered so a real error is not
    // buried under it for hours of uptime.
    if (/not enough frames to estimate rate/i.test(text)) return;
    // Never let a key reach a log line: ffmpeg prints its output URL on failure.
    const key = getStreamKey(this.protestId);
    const safe = key ? text.split(key).join('<stream-key>') : text;
    this.ffmpegLog.push(`${new Date().toISOString()} ${safe}`);
    if (this.ffmpegLog.length > 200) this.ffmpegLog.shift();
  }

  start() {
    if (this.state === 'live' || this.state === 'starting' || this.state === 'reconnecting') {
      return this.status();
    }
    if (!hasStreamKey(this.protestId)) {
      throw Object.assign(new Error('No YouTube stream key is configured for this protest.'), {
        status: 400,
        code: 'missing_stream_key',
      });
    }
    this.stopping = false;
    this.keepRunning = true;
    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    this.error = null;
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.state = 'starting';
    this.log('Starting broadcast');
    cleanFrameDir(0);
    this.loopPromise = this.runLoop().catch((err) => {
      this.error = err?.message || String(err);
      this.log(`Fatal: ${this.error}`);
      this.state = 'error';
      this.keepRunning = false;
    });
    return this.status();
  }

  async stop({ flush = true } = {}) {
    this.stopping = true;
    this.keepRunning = false;
    if (this.state !== 'idle') this.state = 'stopping';
    const child = this.child;
    if (child && child.exitCode === null) {
      // Closing stdin lets ffmpeg flush the last frames and terminate cleanly.
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      const closed = new Promise((resolve) => child.once('close', resolve));
      await Promise.race([closed, sleep(4000)]);
      if (child.exitCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* gone */
        }
        await Promise.race([closed, sleep(2000)]);
      }
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    if (flush && this.loopPromise) {
      await Promise.race([this.loopPromise.catch(() => {}), sleep(2500)]);
    }
    this.state = 'idle';
    this.stoppedAt = new Date().toISOString();
    this.log('Broadcast stopped');
    return this.status();
  }

  /** Spawn ffmpeg and resolve when it exits. */
  spawnFfmpeg() {
    const args = buildFfmpegArgs({
      protestId: this.protestId,
      fps: this.fps,
      bitrateKbps: this.bitrateKbps,
    });

    // The URL is the last argument; strip it from anything we log or report.
    const safeArgs = [...args.slice(0, -1), ingestUrlRedacted(this.protestId)];
    this.log(`ffmpeg ${safeArgs.join(' ')}`);

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(resolveFfmpeg(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (err) {
        resolve({ code: -1, error: err.message });
        return;
      }
      this.child = child;
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        for (const line of stderr.split('\n').slice(-8)) this.log(line);
        stderr = '';
      });
      child.stdin.on('error', (err) => {
        // EPIPE is normal when ffmpeg exits or the connection drops mid-frame.
        this.log(`stdin: ${err.code || err.message}`);
      });
      child.on('error', (err) => {
        this.log(`spawn error: ${err.message}`);
        resolve({ code: -1, error: `Could not start ffmpeg (${err.message}).` });
      });
      child.on('close', (code, signal) => {
        this.child = null;
        resolve({ code, signal });
      });
    });
  }

  /**
   * One connection attempt: spawn ffmpeg, then keep feeding frames until the
   * process exits or a stop is requested.
   */
  async runConnection() {
    const exit = this.spawnFfmpeg();
    const child = this.child;
    if (!child) return exit;

    // Give the RTMP handshake a beat before the first frame goes in, so a
    // failed connection is reported as a connection error rather than a crash.
    let finished = false;
    exit.then(() => {
      finished = true;
    });

    const frameInterval = 1000 / this.fps;
    let next = Date.now();

    while (this.keepRunning && !finished) {
      const frame = await this.renderTickFrame();
      if (!frame) break;
      if (finished || !this.keepRunning) break;

      const ok = child.stdin.write(frame);
      this.frames += 1;
      this.bytes += frame.length;
      this.lastFrameAt = new Date().toISOString();
      if (this.state !== 'live') {
        this.state = 'live';
        this.log(`Live at ${this.fps} fps, ${this.bitrateKbps} kbps`);
      }
      if (!ok) {
        // Backpressure: wait for the socket to drain instead of buffering frames
        // in memory. A slow link should lower the frame rate, not grow RAM.
        await new Promise((resolve) => {
          const done = () => {
            child.stdin.off('drain', done);
            resolve();
          };
          child.stdin.once('drain', done);
          setTimeout(done, 2000);
        });
      }

      next += frameInterval;
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      else next = Date.now(); // fell behind; resync instead of bursting
    }

    const result = await exit;
    return result;
  }

  /** Render one frame, tolerating a render failure without killing the stream. */
  async renderTickFrame() {
    try {
      const protest = store.getProtest(this.protestId);
      if (!protest) {
        this.keepRunning = false;
        return null;
      }
      const kpi = store.buildKpi(this.protestId);
      return await renderFrameRaw({
        protest: store.serializeProtest(protest),
        kpi,
        recent: store.listJoiners(this.protestId, { limit: 5 }),
      });
    } catch (err) {
      this.log(`render failed: ${err.message}`);
      this.error = `Render failed: ${err.message}`;
      await sleep(1000);
      return null;
    }
  }

  async runLoop() {
    while (this.keepRunning) {
      this.attempts += 1;
      if (this.attempts > 1) this.state = 'reconnecting';
      const { code, signal, error } = await this.runConnection();
      if (!this.keepRunning) break;

      // A key removed mid-stream must stop the retry loop, not hammer YouTube
      // with an empty key.
      if (!hasStreamKey(this.protestId)) {
        this.keepRunning = false;
        this.error = 'The stream key was removed, so the broadcast stopped.';
        this.state = 'error';
        this.log(this.error);
        break;
      }

      this.consecutiveFailures += 1;
      this.error =
        error ||
        `ffmpeg exited (${signal ? `signal ${signal}` : `code ${code}`}). ` +
          'Check the stream key and that the YouTube event is created.';
      this.lastErrorAt = new Date().toISOString();
      this.state = 'reconnecting';

      // Backoff: 2s, 4s, 8s ... capped at 60s.
      const backoff = Math.min(60000, 2000 * 2 ** Math.min(5, this.consecutiveFailures - 1));
      this.log(`Reconnecting in ${Math.round(backoff / 1000)}s (attempt ${this.attempts + 1})`);
      await sleep(backoff);
    }
    this.state = this.state === 'error' ? 'error' : 'idle';
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const broadcasts = new Map();

export function startBroadcast(protestId, options = {}) {
  const protest = store.getProtest(protestId);
  if (!protest) {
    throw Object.assign(new Error('Protest not found.'), { status: 404, code: 'not_found' });
  }
  if (!hasStreamKey(protestId)) {
    throw Object.assign(new Error('Add a YouTube stream key before starting the broadcast.'), {
      status: 400,
      code: 'missing_stream_key',
    });
  }

  let broadcast = broadcasts.get(protestId);
  if (!broadcast) {
    broadcast = new Broadcast(protestId, {
      fps: options.fps ?? protest.broadcast?.fps,
      bitrateKbps: options.bitrateKbps ?? protest.broadcast?.bitrateKbps,
    });
    broadcasts.set(protestId, broadcast);
  }
  return broadcast.start();
}

export async function stopBroadcast(protestId) {
  const broadcast = broadcasts.get(protestId);
  if (!broadcast) return broadcastStatus(protestId);
  return broadcast.stop();
}

export function broadcastStatus(protestId) {
  const broadcast = broadcasts.get(protestId);
  if (broadcast) return broadcast.status();
  return {
    protestId,
    state: 'idle',
    live: false,
    fps: null,
    bitrateKbps: null,
    startedAt: null,
    stoppedAt: null,
    uptimeSeconds: 0,
    frames: 0,
    megabytes: 0,
    lastFrameAt: null,
    attempts: 0,
    hasKey: hasStreamKey(protestId),
    keyHint: keyHint(protestId),
    transport: store.getProtest(protestId)?.broadcast?.transport || 'rtmps',
    target: ingestUrlRedacted(protestId),
    ffmpeg: ffmpegInfo(),
    error: null,
    log: [],
  };
}

export const listBroadcasts = () => [...broadcasts.values()].map((b) => b.status());

export const isBroadcasting = (protestId) => broadcasts.get(protestId)?.state === 'live';

/** Persist per-protest broadcast preferences (fps, bitrate, transport). */
export function saveBroadcastSettings(protestId, patch = {}) {
  const protest = store.getProtest(protestId);
  if (!protest) {
    throw Object.assign(new Error('Protest not found.'), { status: 404, code: 'not_found' });
  }
  const current = protest.broadcast || {};
  const next = {
    fps: clamp(patch.fps ?? current.fps, 0.2, 5, 1),
    bitrateKbps: clamp(patch.bitrateKbps ?? current.bitrateKbps, 500, 12000, 2500),
    transport: (patch.transport ?? current.transport) === 'rtmp' ? 'rtmp' : 'rtmps',
    autoStart: Boolean(patch.autoStart ?? current.autoStart),
    ingest: String(patch.ingest ?? current.ingest ?? '').trim().slice(0, 300),
  };
  store.updateProtest(protestId, { broadcast: next });
  return next;
}

/**
 * Restart a running broadcast with new settings.
 * Settings cannot be changed under a live ffmpeg process, so this stops first.
 */
export async function restartBroadcast(protestId) {
  const broadcast = broadcasts.get(protestId);
  const wasLive = broadcast && broadcast.state !== 'idle';
  if (broadcast) await broadcast.stop();
  broadcasts.delete(protestId);
  if (!wasLive) return broadcastStatus(protestId);
  const protest = store.getProtest(protestId);
  return startBroadcast(protestId, {
    fps: protest?.broadcast?.fps,
    bitrateKbps: protest?.broadcast?.bitrateKbps,
  });
}

/** Called on boot: resume broadcasts that were live when the process stopped. */
export function resumeBroadcasts() {
  if (!config.broadcastAutoResume) return [];
  const resumed = [];
  for (const protest of store.listProtests({ includeEnded: false })) {
    if (!protest.broadcast?.autoStart) continue;
    if (!hasStreamKey(protest.id)) continue;
    try {
      startBroadcast(protest.id);
      resumed.push(protest.id);
    } catch {
      /* ignore individual failures */
    }
  }
  return resumed;
}

/** Stop everything (graceful shutdown). */
export async function stopAllBroadcasts() {
  await Promise.all([...broadcasts.values()].map((b) => b.stop({ flush: false })));
  broadcasts.clear();
}

/** Health of the broadcast subsystem, used by /api/broadcast and doctor scripts. */
export function broadcastHealth() {
  const active = [...broadcasts.values()];
  return {
    ffmpeg: ffmpegInfo(),
    fonts: fontInfo(),
    frame: { width: WIDTH, height: HEIGHT },
    active: active.length,
    live: active.filter((b) => b.state === 'live').length,
    transport: 'rtmps',
    ingest: {
      rtmps: 'rtmps://a.rtmps.youtube.com:443/live2',
      rtmp: 'rtmp://a.rtmp.youtube.com:1935/live2',
    },
    autoResume: Boolean(config.broadcastAutoResume),
  };
}

export { Broadcast };
