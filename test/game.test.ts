import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('recentChat com afterSeq faz catch-up sem pular mensagens', () => {
    const { game, reg, advance } = setup();
    const { agent } = reg('ed');
    for (let i = 0; i < 5; i++) { game.sendMessage(agent, `m${i}`); advance(1001); }
    const all = game.recentChat(10);
    // limit=2 após a 2ª mensagem deve trazer as 2 mais antigas seguintes (não as mais novas)
    expect(game.recentChat(2, all[1]!.seq).map((m) => m.text)).toEqual(['m2', 'm3']);
  });
});

describe('persistência', () => {
  const fileDb = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixel-ia-'));
    return { dir, db: join(dir, 't.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('canvas é reconstruído do event log ao reabrir', () => {
    const { dir, db, cleanup } = fileDb();
    const g1 = new Game({ ...cfg, dbPath: db, cooldownMinMs: 0, cooldownMaxMs: 0 }, () => 1_000_000);
    const a = g1.register('fi', ''); if (!a.ok) throw new Error();
    g1.placePixel(a.agent, 3, 4, 9);
    g1.placePixel(a.agent, 3, 4, 2); // sobrescreve: replay deve ficar com o último
    g1.close();
    const g2 = new Game({ ...cfg, dbPath: db }, () => 1_000_000);
    expect(g2.canvas[4 * 100 + 3]).toBe(2);
    g2.close();
    cleanup();
  });

  it('rate limit do chat vem do banco e sobrevive a reabertura', () => {
    const { dir, db, cleanup } = fileDb();
    const g1 = new Game({ ...cfg, dbPath: db }, () => 1_000_000);
    const a = g1.register('gi', ''); if (!a.ok) throw new Error();
    g1.sendMessage(a.agent, 'oi');
    g1.close();
    const g2 = new Game({ ...cfg, dbPath: db }, () => 1_000_500);
    expect(g2.sendMessage(a.agent, 'spam')).toMatchObject({ ok: false, code: 'RATE_LIMIT' });
    g2.close();
    cleanup();
  });
});

describe('rastreio de pixels e perfil', () => {
  it('guarda quem e quando; histórico mostra sobrescritas', () => {
    const { game, reg, advance } = setup();
    const a = reg('ana').agent, b = reg('beto').agent;
    game.placePixel(a, 7, 8, 1);
    advance(20_000);
    game.placePixel(b, 7, 8, 2);
    const h = game.pixelHistory(7, 8);
    expect(h.map((e) => e.agent)).toEqual(['beto', 'ana']);
    expect(h[0]!.ts).toBeGreaterThan(h[1]!.ts);
    expect(game.pixelHistory(0, 0)).toEqual([]);
  });

  it('perfil traz contadores e atividade', () => {
    const { game, reg, advance } = setup();
    const a = reg('cris').agent;
    game.placePixel(a, 1, 1, 3);
    advance(20_000);
    game.sendMessage(a, 'oi');
    const p = game.agentProfile('cris')!;
    expect(p).toMatchObject({ name: 'cris', pixels: 1, messages: 1 });
    expect(p.recentPixels).toHaveLength(1);
    expect(game.agentProfile('ninguem')).toBeNull();
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
    expect((await app.inject({ method: 'GET', url: '/api/v1/canvas?x=100&y=0&w=10&h=10' })).statusCode).toBe(400);
    const bin = await app.inject({ method: 'GET', url: '/api/v1/canvas.bin' });
    expect(bin.headers['x-canvas-width']).toBe('100');
    expect(bin.rawPayload).toHaveLength(10_000);
    const at = (await app.inject({ method: 'GET', url: '/api/v1/pixels/at?x=50&y=50' })).json();
    expect(at.current.agent).toBe('eve');
    expect((await app.inject({ method: 'GET', url: '/api/v1/pixels/at?x=500&y=1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/agents/eve' })).json().agent.pixels).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/agents/zzz' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/skill.md' })).body).toContain('/api/v1');
    await app.close();
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
