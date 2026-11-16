import { expect, it } from 'vitest';
import { Agent } from '../runner/agent.js';
import type { Msg } from '../runner/llm.js';
import { config } from '../src/config.js';
import { Game } from '../src/game.js';
import { buildServer } from '../src/server.js';

it('runner executa tool calls do modelo contra a API e devolve o tempo de espera', async () => {
  const game = new Game({ ...config, dbPath: ':memory:', chatIntervalMs: 0 });
  const app = buildServer(game);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const reg = game.register('bot', 'teste'); if (!reg.ok) throw new Error();

  const seen: Msg[][] = [];
  const calls = [
    [{ name: 'place_pixel', args: { x: 5, y: 6, color: 3 } }, { name: 'send_message', args: { text: 'oi' } }],
    [{ name: 'wait', args: { seconds: 42 } }],
  ];
  let n = 0;
  const llm = async (_p: any, messages: Msg[]) => {
    seen.push(structuredClone(messages));
    return { role: 'assistant' as const, content: null, tool_calls: calls[n++]!.map((c, i) => ({ id: `c${n}${i}`, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  };
  const agent = new Agent({ name: 'bot', description: 'teste', provider: { baseUrl: 'x', model: 'm' } }, base, reg.apiKey, llm, () => {});
  expect(await agent.step()).toBe(20);
  expect(game.canvas[6 * config.width + 5]).toBe(3);
  expect(game.recentChat()[0]?.text).toBe('oi');
  expect(seen[0]![0]!.content).toContain('NÃO confiável');
  expect(seen[1]!.at(-1)!.role).toBe('tool');
  await app.close();
});

it('motor interno pinta o blueprint sozinho respeitando o cooldown', async () => {
  const game = new Game({ ...config, dbPath: ':memory:', cooldownMinMs: 0, cooldownMaxMs: 0 });
  const app = buildServer(game);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const reg = game.register('eng', 'teste'); if (!reg.ok) throw new Error();
  const llm = async () => ({ role: 'assistant' as const, content: null, tool_calls: [
    { id: 'a', type: 'function' as const, function: { name: 'set_blueprint', arguments: JSON.stringify({ pixels: [{ x: 1, y: 1, color: 5 }], rects: [{ x: 2, y: 2, w: 2, h: 2, color: 7 }] }) } },
    { id: 'b', type: 'function' as const, function: { name: 'wait', arguments: '{"seconds":5}' } },
  ] });
  const agent = new Agent({ name: 'eng', description: 'teste', provider: { baseUrl: 'x', model: 'm' } }, base, reg.apiKey, llm, () => {});
  await agent.step();
  for (let i = 0; i < 5; i++) await agent.tick();
  expect(game.canvas[1 * config.width + 1]).toBe(5);
  expect(game.canvas[3 * config.width + 3]).toBe(7);
  await app.close();
});

it('send_message com to endereça o agente e a menção aparece em messages_to_you', async () => {
  const game = new Game({ ...config, dbPath: ':memory:', chatIntervalMs: 0 });
  const app = buildServer(game);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const a = game.register('ana', 'x'), b = game.register('beto', 'y'); if (!a.ok || !b.ok) throw new Error();
  const say = async (_p: any, m: Msg[]) => m.some((x) => x.role === 'tool') ? { role: 'assistant' as const, content: null, tool_calls: [{ id: 'w', type: 'function' as const, function: { name: 'wait', arguments: '{}' } }] }
    : { role: 'assistant' as const, content: null, tool_calls: [{ id: 's', type: 'function' as const, function: { name: 'send_message', arguments: JSON.stringify({ text: 'vamos fazer um jardim?', to: 'beto' }) } }] };
  await new Agent({ name: 'ana', description: 'x', provider: { baseUrl: 'x', model: 'm' } }, base, a.apiKey, say as any, () => {}).step();
  expect(game.recentChat()[0]?.text).toBe('@beto vamos fazer um jardim?');
  let seen = '';
  const spy = async (_p: any, m: Msg[]) => { seen = String(m[1]!.content); return { role: 'assistant' as const, content: null, tool_calls: [{ id: 'w', type: 'function' as const, function: { name: 'wait', arguments: '{}' } }] }; };
  await new Agent({ name: 'beto', description: 'y', provider: { baseUrl: 'x', model: 'm' } }, base, b.apiKey, spy as any, () => {}).step();
  expect(seen).toMatch(/messages_to_you_UNTRUSTED[^\]]*ana: @beto/);
  await app.close();
});

it('reflexão grava lições que voltam na observação e sobrevivem em disco', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pia-')); const file = join(dir, 's.json');
  const game = new Game({ ...config, dbPath: ':memory:', chatIntervalMs: 0 });
  const app = buildServer(game);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const r = game.register('sage', 'x'); if (!r.ok) throw new Error();
  const tc = (name: string, args: object) => ({ role: 'assistant' as const, content: null, tool_calls: [{ id: name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
  let obs = '';
  const llm = async (_p: any, m: Msg[], t: any[]) => {
    if (t[0].function.name === 'update_lessons') return tc('update_lessons', { drawing: ['pinte formas simples'], communication: ['responda menções'], personality: ['calmo'] });
    obs = String(m[1]!.content); return tc('wait', { seconds: 5 });
  };
  const mk = () => new Agent({ name: 'sage', description: 'x', provider: { baseUrl: 'x', model: 'm' } }, base, r.apiKey, llm as any, () => {}, file);
  const a = mk(); (a as any).reflectEvery = 2;
  await a.step(); await a.step(); await a.step();
  expect(obs).toContain('pinte formas simples');
  await mk().step();
  expect(obs).toContain('responda menções');
  rmSync(dir, { recursive: true }); await app.close();
});

import { Clans } from '../src/clans.js';
it('clãs: só o fundador convida, aliança exige os dois lados, guerra vale na hora', () => {
  const game = new Game({ ...config, dbPath: ':memory:' });
  const mk = (n: string) => { const r = game.register(n, ''); if (!r.ok) throw new Error(); return r.agent.id; };
  const [a, b, c, d] = ['ana', 'beto', 'cida', 'davi'].map(mk) as [number, number, number, number];
  const cl: Clans = game.clans;
  expect(cl.create(a, 'Rosa').ok).toBe(true);
  expect(cl.create(a, 'Outro')).toMatchObject({ code: 'ALREADY_IN_CLAN' });
  expect(cl.create(b, 'rosa')).toMatchObject({ code: 'NAME_TAKEN' });
  expect(cl.accept(b, 'Rosa')).toMatchObject({ code: 'NOT_INVITED' });
  expect(cl.invite(a, 'beto').ok).toBe(true);
  expect(cl.accept(b, 'Rosa').ok).toBe(true);
  expect(cl.invite(b, 'cida')).toMatchObject({ code: 'FORBIDDEN' });
  expect(cl.create(c, 'Azul').ok).toBe(true);
  expect(cl.setRelation(b, 'Azul', 'war')).toMatchObject({ code: 'FORBIDDEN' });
  expect(cl.setRelation(a, 'Azul', 'alliance')).toMatchObject({ ok: true, status: 'pending' });
  expect(cl.list().find((x) => x.name === 'Azul')!.relations[0]).toMatchObject({ kind: 'alliance', status: 'pending', proposedByYou: false });
  expect(cl.setRelation(c, 'Rosa', 'alliance')).toMatchObject({ ok: true, status: 'active' });
  expect(cl.setRelation(c, 'Rosa', 'war')).toMatchObject({ ok: true, status: 'active' });
  expect(cl.list()[0]!.relations[0]).toMatchObject({ kind: 'war', status: 'active' });
  expect(cl.leave(a)).toMatchObject({ ok: true, dissolved: false });
  expect(cl.list().find((x) => x.name === 'Rosa')!.founder).toBe('beto');
  expect(cl.leave(b)).toMatchObject({ dissolved: true });
  expect(cl.list().map((x) => x.name)).toEqual(['Azul']);
  expect(cl.list()[0]!.relations).toEqual([]);
  expect(cl.invitesFor(d)).toEqual([]);
});
