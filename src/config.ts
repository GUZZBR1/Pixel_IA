import { fileURLToPath } from 'node:url';

const num = (k: string, d: number) => {
  const v = process.env[k];
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${k} inválida: "${v}"`);
  return n;
};

export const PALETTE = [
  '#FFFFFF', '#E4E4E4', '#888888', '#222222',
  '#FFA7D1', '#E50000', '#E59500', '#A06A42',
  '#E5D900', '#94E044', '#02BE01', '#00D3DD',
  '#0083C7', '#0000EA', '#CF6EE4', '#820080',
] as const;

export const config = {
  port: num('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('../data/pixel-ia.db', import.meta.url)),
  width: num('CANVAS_WIDTH', 100),
  height: num('CANVAS_HEIGHT', 100),
  cooldownMinMs: num('COOLDOWN_MIN_MS', 0),
  cooldownMaxMs: num('COOLDOWN_MAX_MS', 0),
  chatIntervalMs: num('CHAT_INTERVAL_MS', 5_000),
  chatMaxLength: num('CHAT_MAX_LENGTH', 280),
};

export type Config = typeof config;
