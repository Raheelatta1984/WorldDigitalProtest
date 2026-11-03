/**
 * broadcast-render.js
 * -------------------
 * Draws the 1920x1080 broadcast frame that is pushed to YouTube Live.
 *
 * Server-side on purpose: the stream must keep running with no browser open and
 * no operator watching. Frames are drawn with pureimage (DejaVu fonts, found on
 * the host or set via WDP_FONT_REGULAR) and returned as raw RGBA so ffmpeg can
 * encode them without a JavaScript image codec in the hot path.
 *
 * Performance shape:
 *   static layer   background, panels, headings, country/age labels, coastlines
 *   dynamic layer  live numbers, bars, map bubbles, ticker, clock
 *
 * The static layer is rendered once per protest and reused until something that
 * affects the layout changes. That takes a frame from ~650 ms to ~60 ms, which is
 * what makes a steady one-frame-per-second push affordable in a single process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pureimage = require('pureimage');

export const WIDTH = 1920;
export const HEIGHT = 1080;

const tmpDir = process.env.WDP_FRAME_DIR || path.join(process.cwd(), 'var', 'frames');
fs.mkdirSync(tmpDir, { recursive: true });

const COLOURS = {
  bg0: '#070b14',
  bg1: '#0c1322',
  panel: 'rgba(16,26,44,0.92)',
  panelEdge: 'rgba(34,49,76,1)',
  text: '#eef3fb',
  muted: '#93a4c1',
  dim: '#6c7f9e',
  accent: '#2ee6a8',
  violet: '#a78bfa',
  rose: '#fb7185',
  amber: '#ffd166',
  track: 'rgba(34,49,76,0.9)',
};

const GENDER_LABEL = {
  female: 'Female',
  male: 'Male',
  'non-binary': 'Non-binary',
  undisclosed: 'Prefer not to say',
};

const PAD = 64;
const TOP_PANEL_X = PAD + 1120 + 24;
const TOP_PANEL_W = WIDTH - PAD - TOP_PANEL_X;
const HALF_W = (TOP_PANEL_W - 44) / 2;
const TICKER_Y = 968;

// ---------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------

const FONT_CANDIDATES = [
  process.env.WDP_FONT_REGULAR,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
].filter(Boolean);

const BOLD_CANDIDATES = [
  process.env.WDP_FONT_BOLD,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  'C:\\Windows\\Fonts\\arialbd.ttf',
].filter(Boolean);

const firstExisting = (list) =>
  list.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

let fontsReady = null;
let regularFamily = null;
let boldFamily = null;

export async function ensureFonts() {
  if (fontsReady !== null) return fontsReady;
  const regular = firstExisting(FONT_CANDIDATES);
  if (!regular) {
    fontsReady = false;
    return false;
  }
  const bold = firstExisting(BOLD_CANDIDATES);
  regularFamily = 'WDPRegular';
  boldFamily = bold ? 'WDPBold' : 'WDPRegular';
  try {
    await pureimage.registerFont(regular, regularFamily).load();
    if (bold) await pureimage.registerFont(bold, boldFamily).load();
    fontsReady = true;
  } catch {
    fontsReady = false;
  }
  return fontsReady;
}

export const fontsAvailable = () => fontsReady === true;

/** Which font files this process will use (reported by /api/broadcast). */
export const fontInfo = () => ({
  regular: firstExisting(FONT_CANDIDATES) || null,
  bold: firstExisting(BOLD_CANDIDATES) || null,
  ready: fontsReady === true,
});

const FONT_CACHE = new Map();
const font = (size, bold = false) => {
  const key = `${bold ? 'b' : 'r'}:${Math.round(size)}`;
  if (!FONT_CACHE.has(key)) {
    FONT_CACHE.set(key, `${Math.round(size)}pt ${bold ? boldFamily : regularFamily}`);
  }
  return FONT_CACHE.get(key);
};

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

const rgba = (hex, alpha) => {
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
};

const numberFmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '—');

const compact = (n) => {
  const num = Number(n || 0);
  if (num < 1000) return String(num);
  if (num < 1e6) return `${(num / 1000).toFixed(num < 1e4 ? 1 : 0)}k`;
  return `${(num / 1e6).toFixed(num < 1e7 ? 1 : 0)}M`;
};

const ellipsize = (value, limit) => {
  const str = String(value ?? '');
  return str.length <= limit ? str : `${str.slice(0, limit - 1)}…`;
};

/** Filled circle as a polygon: pureimage's arc stroking is slow and noisy. */
function circle(ctx, cx, cy, radius, colour) {
  if (!(radius > 0)) return;
  const steps = Math.max(14, Math.min(72, Math.round(radius * 1.4)));
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = COLOURS.panel;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = COLOURS.panelEdge;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillRect(x + w - 2, y, 2, h);
}

function bar(ctx, x, y, width, height, fraction, colour) {
  ctx.fillStyle = COLOURS.track;
  ctx.fillRect(x, y, width, height);
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  if (filled > 0) {
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, filled, height);
  }
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/**
 * Text rendered through a sprite cache.
 *
 * pureimage rasterises glyph outlines on every fillText call (6-20 ms per string
 * at 1080p). Labels and numbers repeat heavily, so each unique string/size/colour
 * is rasterised once and alpha-composited afterwards.
 */
const TEXT_CACHE = new Map();
const TEXT_CACHE_LIMIT = 600;

/** Real glyph measurements, so sprites are wide enough to hold the whole string. */
const measureCanvas = () => pureimage.make(8, 8).getContext('2d');
let measureCtx = null;
const MEASURE_CACHE = new Map();

function measure(str, size, bold) {
  const key = `${bold ? 'b' : 'r'}:${Math.round(size)}:${str}`;
  const hit = MEASURE_CACHE.get(key);
  if (hit !== undefined) return hit;
  if (!measureCtx) measureCtx = measureCanvas();
  measureCtx.font = font(size, bold);
  const width = measureCtx.measureText(str).width || str.length * size * 0.6;
  if (MEASURE_CACHE.size > 2000) MEASURE_CACHE.clear();
  MEASURE_CACHE.set(key, width);
  return width;
}

function text(ctx, bitmap, value, x, y, options = {}) {
  const { size = 16, bold = false, colour = COLOURS.text, align = 'left' } = options;
  const str = String(value ?? '');
  if (!str) return;

  const key = `${bold ? 'b' : 'r'}:${Math.round(size)}:${colour}:${str}`;
  let sprite = TEXT_CACHE.get(key);

  const padX = Math.ceil(size * 0.28);
  const baseline = Math.ceil(size * 1.34);

  if (!sprite) {
    const height = Math.ceil(size * 1.9);
    const measured = measure(str, size, bold);
    const width = Math.ceil(measured) + padX * 2 + 2;
    const canvas = pureimage.make(width, height);
    canvas.data.fill(0); // pi.make() starts opaque white; glyphs need transparency
    const spriteCtx = canvas.getContext('2d');
    spriteCtx.font = font(size, bold);
    spriteCtx.fillStyle = colour;
    spriteCtx.fillText(str, padX, baseline);
    sprite = { canvas, width, height, textWidth: measured, padX, baseline };
    if (TEXT_CACHE.size >= TEXT_CACHE_LIMIT) TEXT_CACHE.delete(TEXT_CACHE.keys().next().value);
    TEXT_CACHE.set(key, sprite);
  }

  const textWidth = sprite.textWidth;
  const originX = Math.round(
    align === 'center' ? x - textWidth / 2 : align === 'right' ? x - textWidth : x
  ) - sprite.padX;
  const originY = Math.round(y - sprite.baseline);

  const dest = bitmap.data;
  const destW = bitmap.width;
  const destH = bitmap.height;
  const src = sprite.canvas.data;
  const srcW = sprite.width;

  for (let sy = 0; sy < sprite.height; sy += 1) {
    const ty = originY + sy;
    if (ty < 0 || ty >= destH) continue;
    const srcRow = sy * srcW;
    const destRow = ty * destW;
    for (let sx = 0; sx < srcW; sx += 1) {
      const tx = originX + sx;
      if (tx < 0 || tx >= destW) continue;
      const si = (srcRow + sx) * 4;
      const alpha = src[si + 3];
      if (!alpha) continue;
      const di = (destRow + tx) * 4;
      if (alpha === 255) {
        dest[di] = src[si];
        dest[di + 1] = src[si + 1];
        dest[di + 2] = src[si + 2];
      } else {
        const a = alpha / 255;
        const inv = 1 - a;
        dest[di] = (src[si] * a + dest[di] * inv) | 0;
        dest[di + 1] = (src[si + 1] * a + dest[di + 1] * inv) | 0;
        dest[di + 2] = (src[si + 2] * a + dest[di + 2] * inv) | 0;
      }
      dest[di + 3] = 255;
    }
  }
}

// ---------------------------------------------------------------------------
// world map
// ---------------------------------------------------------------------------

let mapCache = null;
const loadMap = () => {
  if (mapCache !== null) return mapCache;
  const file = path.join(process.cwd(), 'public', 'assets', 'data', 'world.map.json');
  try {
    mapCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    mapCache = false;
  }
  return mapCache;
};

const MAP_BOX = { x: PAD + 18, y: 538, w: 1120 - 36, h: 420 - 36 };

let landPathsCache = null;
function landPaths() {
  if (landPathsCache) return landPathsCache;
  const map = loadMap();
  if (!map || !map.polygons) return [];
  const latMax = Number.isFinite(map.latMax) ? map.latMax : 84;
  const latMin = Number.isFinite(map.latMin) ? map.latMin : -58;
  const project = (lng, lat) => [
    MAP_BOX.x + ((lng + 180) / 360) * MAP_BOX.w,
    MAP_BOX.y + ((latMax - Math.max(latMin, Math.min(latMax, lat))) / (latMax - latMin)) * MAP_BOX.h,
  ];
  landPathsCache = map.polygons
    .map((poly) => poly.rings[0])
    .filter((ring) => ring && ring.length >= 3)
    .map((ring) => ring.map((point) => project(point[0], point[1])));
  return landPathsCache;
}

function drawLand(ctx) {
  ctx.fillStyle = 'rgba(38,55,84,0.85)';
  for (const points of landPaths()) {
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 1) {
      if (i === 0) ctx.moveTo(points[i][0], points[i][1]);
      else ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function drawBubbles(ctx, bitmap, countries) {
  const map = loadMap();
  const latMax = map && Number.isFinite(map.latMax) ? map.latMax : 84;
  const latMin = map && Number.isFinite(map.latMin) ? map.latMin : -58;
  const project = (lng, lat) => [
    MAP_BOX.x + ((lng + 180) / 360) * MAP_BOX.w,
    MAP_BOX.y + ((latMax - Math.max(latMin, Math.min(latMax, lat))) / (latMax - latMin)) * MAP_BOX.h,
  ];

  const points = (countries || []).filter((c) => c.lat && c.lng);
  const max = points.reduce((m, p) => Math.max(m, p.count), 0) || 1;
  const sorted = [...points].sort((a, b) => b.count - a.count);

  const placed = [];
  const labelFits = (x, y, label) => {
    const width = label.length * 7.4;
    const box = { x1: x - width / 2, x2: x + width / 2, y1: y - 14, y2: y + 4 };
    const clash = placed.some(
      (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2)
    );
    if (!clash) placed.push(box);
    return !clash;
  };

  sorted.forEach((point, index) => {
    const [px, py] = project(point.lng, point.lat);
    const scale = Math.sqrt(point.count / max);
    const radius = 4 + scale * 30;
    circle(ctx, px, py, radius, rgba(COLOURS.accent, 0.1 + 0.14 * scale));
    circle(ctx, px, py, radius * 0.62, rgba(COLOURS.accent, 0.22 + 0.2 * scale));
    circle(ctx, px, py, radius * 0.3, rgba(COLOURS.accent, 0.5 + 0.35 * scale));
    circle(ctx, px, py, Math.max(2.5, radius * 0.12), COLOURS.accent);

    if (index < 10) {
      const label = `${ellipsize(point.name, 18)} ${compact(point.count)}`;
      const labelX = Math.max(MAP_BOX.x + 70, Math.min(MAP_BOX.x + MAP_BOX.w - 70, px));
      const labelY = py - radius - 9;
      if (labelFits(labelX, labelY, label)) {
        text(ctx, bitmap, label, labelX, labelY, { size: 13, bold: true, align: 'center' });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

function staticKey({ protest, kpi, brand }) {
  return [
    protest.id,
    protest.phase,
    brand,
    protest.headline,
    (protest.reason || '').length,
    kpi.countryCount,
    kpi.regionCount,
    (kpi.countries || []).slice(0, 6).map((c) => c.name).join(','),
    (kpi.genders || []).map((g) => g.key).join(','),
    (kpi.ages || []).map((a) => a.key).join(','),
  ].join('|');
}

function drawStaticLayer(ctx, bitmap, { protest, kpi, brand = 'World Digital Protest' }) {
  ctx.fillStyle = COLOURS.bg0;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = COLOURS.bg1;
  ctx.fillRect(0, 0, WIDTH, 470);

  // Brand
  ctx.fillStyle = COLOURS.accent;
  ctx.fillRect(PAD, 56, 8, 34);
  text(ctx, bitmap, brand.toUpperCase(), PAD + 22, 82, { size: 17, bold: true, colour: COLOURS.accent });

  // Phase badge
  const live = protest.phase === 'live';
  const phaseLabel = live ? 'LIVE' : protest.phase === 'upcoming' ? 'OPENS SOON' : 'FINISHED';
  ctx.fillStyle = live ? COLOURS.accent : 'rgba(147,164,193,0.3)';
  ctx.fillRect(WIDTH - PAD - 148, 48, 148, 44);
  text(ctx, bitmap, phaseLabel, WIDTH - PAD - 74, 77, {
    size: 18,
    bold: true,
    colour: live ? '#04121a' : COLOURS.text,
    align: 'center',
  });

  // Headline and reason
  text(ctx, bitmap, ellipsize(protest.headline, 62), PAD, 168, { size: 40, bold: true });
  const reason = String(protest.reason || '').replace(/\s+/g, ' ');
  text(ctx, bitmap, ellipsize(reason, 118), PAD, 208, { size: 19, colour: COLOURS.muted });

  // Stat tiles: frames + labels only, numbers are drawn per tick
  const statW = (WIDTH - PAD * 2 - 24 * 3) / 4;
  ['PARTICIPANTS WORLDWIDE', 'COUNTRIES', 'CITIES & AREAS', 'JOINING / MIN'].forEach((label, i) => {
    const x = PAD + i * (statW + 24);
    panel(ctx, x, 250, statW, 156);
    text(ctx, bitmap, label, x + 22, 288, { size: 14, bold: true, colour: COLOURS.dim });
  });

  text(ctx, bitmap, 'PROGRESS TOWARD WORLDWIDE TARGET', PAD, 442, {
    size: 16,
    bold: true,
    colour: COLOURS.muted,
  });

  // Map panel + coastlines
  panel(ctx, PAD, 520, 1120, 420);
  drawLand(ctx);

  // Top countries panel with fixed country labels
  panel(ctx, TOP_PANEL_X, 520, TOP_PANEL_W, 200);
  text(ctx, bitmap, 'TOP COUNTRIES', TOP_PANEL_X + 22, 556, {
    size: 15,
    bold: true,
    colour: COLOURS.dim,
  });
  (kpi.countries || []).slice(0, 6).forEach((country, i) => {
    text(ctx, bitmap, ellipsize(country.name, 16), TOP_PANEL_X + 22, 592 + i * 22, { size: 15 });
  });

  // Demographics panel labels
  panel(ctx, TOP_PANEL_X, 740, TOP_PANEL_W, 200);
  text(ctx, bitmap, 'BY GENDER', TOP_PANEL_X + 20, 772, { size: 15, bold: true, colour: COLOURS.dim });
  (kpi.genders || []).slice(0, 4).forEach((gender, i) => {
    text(ctx, bitmap, ellipsize(GENDER_LABEL[gender.key] || gender.key, 16), TOP_PANEL_X + 20, 801 + i * 30, {
      size: 13,
    });
  });
  const ageX = TOP_PANEL_X + 20 + HALF_W + 24;
  text(ctx, bitmap, 'BY AGE', ageX, 772, { size: 15, bold: true, colour: COLOURS.dim });
  (kpi.ages || []).slice(0, 5).forEach((age, i) => {
    text(ctx, bitmap, age.key, ageX, 801 + i * 24, { size: 13 });
  });

  // Ticker frame
  ctx.fillStyle = 'rgba(16,26,44,0.92)';
  ctx.fillRect(PAD, TICKER_Y, WIDTH - PAD * 2, 62);
  ctx.fillStyle = COLOURS.panelEdge;
  ctx.fillRect(PAD, TICKER_Y, WIDTH - PAD * 2, 2);
  ctx.fillRect(PAD, TICKER_Y + 60, WIDTH - PAD * 2, 2);
  text(ctx, bitmap, 'JOINING NOW', PAD + 20, TICKER_Y + 26, {
    size: 13,
    bold: true,
    colour: COLOURS.accent,
  });
}

function drawDynamicLayer(ctx, bitmap, { protest, kpi, recent = [] }) {
  // Headline numbers
  const stats = [
    {
      value: numberFmt(kpi.total),
      sub: `${numberFmt(kpi.real)} verified · ${numberFmt(kpi.injected)} test`,
      accent: true,
    },
    { value: numberFmt(kpi.countryCount), sub: `${numberFmt(kpi.cityCount)} cities reporting` },
    { value: numberFmt(kpi.cityCount), sub: `${numberFmt(kpi.regionCount)} regions` },
    {
      value: numberFmt(kpi.velocity.perMinute),
      sub: `${numberFmt(kpi.velocity.last5)} in last 5 min`,
    },
  ];
  const statW = (WIDTH - PAD * 2 - 24 * 3) / 4;
  stats.forEach((stat, i) => {
    const x = PAD + i * (statW + 24);
    text(ctx, bitmap, stat.value, x + 22, 354, {
      size: 54,
      bold: true,
      colour: stat.accent ? COLOURS.accent : COLOURS.text,
    });
    text(ctx, bitmap, ellipsize(stat.sub, 34), x + 22, 384, { size: 15, colour: COLOURS.muted });
  });

  // Progress
  text(ctx, bitmap, `${kpi.progress}% of ${compact(kpi.target)}`, PAD + (WIDTH - PAD * 2), 442, {
    size: 19,
    bold: true,
    colour: COLOURS.accent,
    align: 'right',
  });
  bar(ctx, PAD, 458, WIDTH - PAD * 2, 14, kpi.progress / 100, COLOURS.accent);

  // Map bubbles and labels
  drawBubbles(ctx, bitmap, kpi.countries || []);

  // Top country bars and values
  const top = (kpi.countries || []).slice(0, 6);
  const topMax = top.length ? Math.max(...top.map((c) => c.count)) : 1;
  top.forEach((country, i) => {
    const y = 580 + i * 22;
    bar(ctx, TOP_PANEL_X + 168, y, TOP_PANEL_W - 250, 12, country.count / topMax, COLOURS.accent);
    text(ctx, bitmap, compact(country.count), TOP_PANEL_X + TOP_PANEL_W - 22, y + 11, {
      size: 14,
      bold: true,
      colour: COLOURS.muted,
      align: 'right',
    });
  });

  // Demographics bars and percentages
  const genders = (kpi.genders || []).slice(0, 4);
  const genderMax = genders.length ? Math.max(...genders.map((g) => g.count)) : 1;
  genders.forEach((gender, i) => {
    const y = 792 + i * 30;
    bar(ctx, TOP_PANEL_X + 20, y + 14, HALF_W - 66, 8, gender.count / genderMax, COLOURS.rose);
    text(ctx, bitmap, `${gender.share}%`, TOP_PANEL_X + 20 + HALF_W - 24, y + 9, {
      size: 12,
      bold: true,
      colour: COLOURS.muted,
      align: 'right',
    });
  });
  const ageX = TOP_PANEL_X + 20 + HALF_W + 24;
  const ages = (kpi.ages || []).slice(0, 5);
  const ageMax = ages.length ? Math.max(...ages.map((a) => a.count)) : 1;
  ages.forEach((age, i) => {
    const y = 801 + i * 24 - 9;
    bar(ctx, ageX + 52, y + 14, HALF_W - 118, 8, age.count / ageMax, COLOURS.amber);
    text(ctx, bitmap, `${age.share}%`, ageX + HALF_W - 24, y + 9, {
      size: 12,
      bold: true,
      colour: COLOURS.muted,
      align: 'right',
    });
  });

  // Ticker entries and clock
  let tickerX = PAD + 152;
  if (!recent.length) {
    text(ctx, bitmap, `Live worldwide join feed · ${numberFmt(kpi.countryCount)} countries reporting`, tickerX, TICKER_Y + 26, {
      size: 15,
      colour: COLOURS.muted,
    });
  }
  for (const joiner of recent.slice(0, 5)) {
    const label = `${joiner.name} · ${joiner.city || 'Unknown'}, ${joiner.countryName || joiner.country}`;
    const width = label.length * 8.2;
    if (tickerX + width > WIDTH - PAD - 210) break;
    text(ctx, bitmap, ellipsize(label, 46), tickerX, TICKER_Y + 26, {
      size: 15,
      colour: joiner.injected ? COLOURS.violet : COLOURS.muted,
    });
    tickerX += width + 34;
  }
  text(
    ctx,
    bitmap,
    `${new Date(kpi.updatedAt || Date.now()).toISOString().slice(11, 19)} UTC`,
    WIDTH - PAD - 20,
    TICKER_Y + 26,
    { size: 13, colour: COLOURS.dim, align: 'right' }
  );
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

const staticCache = new Map();

const withQuietConsole = async (fn) => {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
};

/**
 * Render one frame as raw RGBA bytes (WIDTH * HEIGHT * 4).
 *
 * Raw pixels go straight into ffmpeg's stdin, so no JavaScript image codec sits
 * in the hot path.
 */
export function renderFrameRaw(input) {
  return withQuietConsole(async () => {
    const ok = await ensureFonts();
    if (!ok) throw new Error('No usable font found for broadcast rendering (set WDP_FONT_REGULAR).');

    const bitmap = pureimage.make(WIDTH, HEIGHT);
    const ctx = bitmap.getContext('2d');

    const key = staticKey(input);
    const cached = staticCache.get(key);
    if (cached) {
      bitmap.data.set(cached);
    } else {
      drawStaticLayer(ctx, bitmap, input);
      // Keep a small number of variants (per protest + phase) alive.
      if (staticCache.size >= 4) staticCache.delete(staticCache.keys().next().value);
      staticCache.set(key, Buffer.from(bitmap.data));
    }

    drawDynamicLayer(ctx, bitmap, input);
    return Buffer.from(bitmap.data);
  });
}

/** Encode a frame to a file; used by the preview CLI and tests. */
export function renderFrame({ format = 'png', ...input }) {
  return withQuietConsole(async () => {
    const ok = await ensureFonts();
    if (!ok) throw new Error('No usable font found for broadcast rendering (set WDP_FONT_REGULAR).');
    const bitmap = pureimage.make(WIDTH, HEIGHT);
    const ctx = bitmap.getContext('2d');
    drawStaticLayer(ctx, bitmap, input);
    drawDynamicLayer(ctx, bitmap, input);

    const file = path.join(
      tmpDir,
      `frame-${Date.now()}-${Math.random().toString(36).slice(2)}.${format === 'jpeg' ? 'jpg' : 'png'}`
    );
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(file);
      stream.on('error', reject);
      const encode = format === 'jpeg' ? pureimage.encodeJPEGToStream : pureimage.encodePNGToStream;
      encode(bitmap, stream)
        .then(() => stream.on('close', resolve))
        .catch(reject);
    });
    return file;
  });
}

export const frameSize = { width: WIDTH, height: HEIGHT };

/** Drop cached layers (used by tests and when a protest is deleted). */
export function clearFrameCache() {
  staticCache.clear();
  TEXT_CACHE.clear();
}

/** Remove frame files older than the given age (called periodically by the pusher). */
export function cleanFrameDir(maxAgeMs = 5 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const entry of fs.readdirSync(tmpDir)) {
      const file = path.join(tmpDir, entry);
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(file);
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* ignore */
  }
}
