import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: path.join(root, 'server', 'data'),
  varDir: process.env.WDP_DATA_DIR
    ? path.resolve(process.env.WDP_DATA_DIR)
    : path.join(root, 'var'),

  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',

  // Demo/test helpers. Injection is what lets us validate global KPIs before a
  // real protest goes live, so it is on by default but clearly labelled in the UI.
  enableTestInjection: bool(process.env.WDP_ENABLE_INJECTION, true),
  injectionToken: process.env.WDP_INJECTION_TOKEN || '',

  // Live stream defaults; a protest may override these with its own YouTube id.
  youtubeChannelUrl:
    process.env.YOUTUBE_CHANNEL_URL || 'https://www.youtube.com/@WorldDigitalProtest',
  youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',

  // How long a single pairing code (offline/BLE handshake) stays valid.
  pairingCodeTtlMs: Number(process.env.WDP_PAIRING_TTL_MS || 15 * 60 * 1000),

  protocolVersion: '1.0',
  maxJoinersPerProtest: Number(process.env.WDP_MAX_JOINERS || 5_000_000),
};

export default config;
