import { PALETTE, type Config } from './config.js';

type Dims = Pick<Config, 'width' | 'height' | 'cooldownMinMs' | 'cooldownMaxMs'>;

export const inBounds = (c: Pick<Config, 'width' | 'height'>, x: number, y: number) =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < c.width && y < c.height;

export const validColor = (color: number) => Number.isInteger(color) && color >= 0 && color < PALETTE.length;

/** Cooldown cresce linearmente com a distância ao centro: centro = min, canto = max. Se max <= min, é um cooldown fixo de min. */
export function cooldownMs(c: Dims, x: number, y: number): number {
  const cx = (c.width - 1) / 2;
  const cy = (c.height - 1) / 2;
  const dist = Math.hypot(x - cx, y - cy);
  const maxDist = Math.hypot(cx, cy) || 1;
  return Math.round(c.cooldownMinMs + Math.max(0, c.cooldownMaxMs - c.cooldownMinMs) * Math.min(dist / maxDist, 1));
}
