import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { Game } from '../src/game.js';
import { cooldownMs } from '../src/rules.js';
import { buildServer } from '../src/server.js';

const cfg = { ...config, dbPath: ':memory:', width: 100, height: 100, cooldownMinMs: 1000, cooldownMaxMs: 10_000, chatIntervalMs: 1000 };

function setup() {
  let t = 1_000_000;
  const game = new Game(cfg, () => t);
  const reg = (name: string) => { const r = game.register(name, ''); if (!r.ok) throw new Error(r.code); return r; };
  return { game, reg, advance: (ms: number) => (t += ms) };
}

describe('cooldown', () => {
  it('cresce com a distância ao centro, respeitando min/max', () => {
    expect(cooldownMs(cfg, 49, 49)).toBeLessThan(cooldownMs(cfg, 20, 20));
    expect(cooldownMs(cfg, 20, 20)).toBeLessThan(cooldownMs(cfg, 0, 0));
    expect(cooldownMs(cfg, 0, 0)).toBe(cfg.cooldownMaxMs);
    expect(cooldownMs(cfg, 49, 50)).toBeGreaterThanOrEqual(cfg.cooldownMinMs);
  });
});

describe('Game', () => {
  it('aceita pixel válido, aplica cooldown e recusa sem alterar o canvas', () => {
    const { game, reg, advance } = setup();
    const { agent } = reg('alice');
    expect(game.placePixel(agent, 10, 10, 5).ok).toBe(true);
    expect(game.canvas[10 * 100 + 10]).toBe(5);
    const r = game.placePixel(agent, 11, 11, 7);
    expect(r).toMatchObject({ ok: false, code: 'COOLDOWN' });
    expect(game.canvas[11 * 100 + 11]).toBe(0);
    advance(10_001);
    expect(game.placePixel(agent, 11, 11, 7).ok).toBe(true);
  });

  it('recusa coordenada e cor inválidas', () => {
    const { game, reg } = setup();
    const { agent } = reg('bob');
    expect(game.placePixel(agent, 100, 0, 1)).toMatchObject({ code: 'OUT_OF_BOUNDS' });
    expect(game.placePixel(agent, 0, 0, 16)).toMatchObject({ code: 'INVALID_COLOR' });
  });

  it('cooldown é individual por agente', () => {
    const { game, reg } = setup();
    expect(game.placePixel(reg('a').agent, 1, 1, 1).ok).toBe(true);
    expect(game.placePixel(reg('b').agent, 2, 2, 2).ok).toBe(true);
  });

  it('nome duplicado é recusado e api_key autentica', () => {
    const { game, reg } = setup();
    const a = reg('carol');
    expect(game.register('CAROL', '')).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
    expect(game.authenticate(a.apiKey)?.name).toBe('carol');
    expect(game.authenticate('pixel_errada')).toBeNull();
  });

  it('chat tem limite de frequência e histórico', () => {
    const { game, reg, advance } = setup();
    const { agent } = reg('dan');
    expect(game.sendMessage(agent, 'oi').ok).toBe(true);
    expect(game.sendMessage(agent, 'de novo')).toMatchObject({ code: 'RATE_LIMIT' });
    advance(1001);
    game.sendMessage(agent, 'agora vai');
    expect(game.recentChat().map((m) => m.text)).toEqual(['oi', 'agora vai']);
  });
});

describe('HTTP', () => {
  it('fluxo completo: registrar, ver estado, pixel e chat', async () => {
    const { game } = setup();
    const app = buildServer(game);
    const reg = await app.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { name: 'eve', description: 'x' } });
    const key = reg.json().agent.api_key as string;
    const h = { authorization: `Bearer ${key}` };

    expect((await app.inject({ method: 'GET', url: '/api/v1/state' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/state', headers: h })).json().you.can_place).toBe(true);

    const px = await app.inject({ method: 'POST', url: '/api/v1/pixels', headers: h, payload: { x: 50, y: 50, color: 3 } });
    expect(px.json().success).toBe(true);
    const again = await app.inject({ method: 'POST', url: '/api/v1/pixels', headers: h, payload: { x: 50, y: 50, color: 4 } });
    expect(again.statusCode).toBe(429);

    await app.inject({ method: 'POST', url: '/api/v1/chat', headers: h, payload: { text: 'olá' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/chat' })).json().messages[0].text).toBe('olá');
    expect((await app.inject({ method: 'GET', url: '/api/v1/canvas?x=50&y=50&w=1&h=1' })).json().rows).toEqual(['3']);
    expect((await app.inject({ method: 'GET', url: '/skill.md' })).body).toContain('/api/v1');
  });
});

describe('sem cooldown', () => {
  it('permite pixels consecutivos quando o cooldown é 0', () => {
    const game = new Game({ ...cfg, cooldownMinMs: 0, cooldownMaxMs: 0 }, () => 1_000_000);
    const r = game.register('zed', ''); if (!r.ok) throw new Error();
    expect(game.placePixel(r.agent, 1, 1, 1).ok).toBe(true);
    expect(game.placePixel(r.agent, 2, 2, 2).ok).toBe(true);
    expect(game.cooldownRemainingMs(r.agent)).toBe(0);
  });
});
