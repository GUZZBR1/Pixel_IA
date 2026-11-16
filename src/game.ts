import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Config } from './config.js';
import { cooldownMs, inBounds, validColor } from './rules.js';

export type Agent = { id: number; name: string; description: string; createdAt: number; nextAllowedAt: number };
export type PixelEvent = { seq: number; type: 'pixel'; agent: string; x: number; y: number; color: number; ts: number };
export type ChatEvent = { seq: number; type: 'chat'; agent: string; text: string; ts: number };
export type GameEvent = PixelEvent | ChatEvent;

export type Result<T> = ({ ok: true } & T) | { ok: false; code: string; message: string; retryAfterMs?: number };

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const fail = (code: string, message: string, extra: object = {}) => ({ ok: false as const, code, message, ...extra });

export class Game extends EventEmitter {
  readonly canvas: Uint8Array;
  private db: DatabaseSync;
  private lastChat = new Map<number, number>();

  constructor(readonly config: Config, private now: () => number = Date.now) {
    super();
    if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        key_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        next_allowed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        agent_id INTEGER NOT NULL REFERENCES agents(id),
        x INTEGER, y INTEGER, color INTEGER, text TEXT,
        ts INTEGER NOT NULL
      );
    `);
    this.canvas = new Uint8Array(config.width * config.height); // 0 = branco
    for (const r of this.db.prepare(`SELECT x, y, color FROM events WHERE type = 'pixel' ORDER BY seq`).all() as any[])
      this.canvas[r.y * config.width + r.x] = r.color;
  }

  register(name: string, description: string): Result<{ agent: Agent; apiKey: string }> {
    const apiKey = `pixel_${randomBytes(24).toString('hex')}`;
    try {
      const ts = this.now();
      const r = this.db
        .prepare('INSERT INTO agents (name, description, key_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(name, description, hash(apiKey), ts);
      return { ok: true, apiKey, agent: { id: Number(r.lastInsertRowid), name, description, createdAt: ts, nextAllowedAt: 0 } };
    } catch (e: any) {
      if (/UNIQUE/.test(String(e?.message))) return fail('NAME_TAKEN', 'Já existe um agente com esse nome.');
      throw e;
    }
  }

  authenticate(apiKey: string): Agent | null {
    const r = this.db.prepare('SELECT * FROM agents WHERE key_hash = ?').get(hash(apiKey)) as any;
    return r ? this.toAgent(r) : null;
  }

  agents(): Pick<Agent, 'name' | 'description'>[] {
    return this.db.prepare('SELECT name, description FROM agents ORDER BY id').all() as any;
  }

  placePixel(agent: Agent, x: number, y: number, color: number): Result<{ cooldownMs: number; nextAllowedAt: number; event: PixelEvent }> {
    if (!inBounds(this.config, x, y)) return fail('OUT_OF_BOUNDS', `Coordenada fora do canvas (${this.config.width}x${this.config.height}).`);
    if (!validColor(color)) return fail('INVALID_COLOR', 'Cor inválida. Use um índice da paleta (0-15).');
    const ts = this.now();
    const current = (this.db.prepare('SELECT next_allowed_at FROM agents WHERE id = ?').get(agent.id) as any).next_allowed_at as number;
    if (this.config.cooldownMaxMs > 0 && ts < current) return fail('COOLDOWN', 'Aguarde o cooldown terminar.', { retryAfterMs: current - ts });

    const cd = cooldownMs(this.config, x, y);
    const nextAllowedAt = ts + cd;
    const seq = this.insertEvent('pixel', agent.id, ts, { x, y, color }, nextAllowedAt);
    this.canvas[y * this.config.width + x] = color;
    const event: PixelEvent = { seq, type: 'pixel', agent: agent.name, x, y, color, ts };
    this.emit('event', event);
    return { ok: true, cooldownMs: cd, nextAllowedAt, event };
  }

  sendMessage(agent: Agent, text: string): Result<{ event: ChatEvent }> {
    text = text.trim();
    if (!text || text.length > this.config.chatMaxLength) return fail('INVALID_MESSAGE', `A mensagem deve ter de 1 a ${this.config.chatMaxLength} caracteres.`);
    const ts = this.now();
    const last = this.lastChat.get(agent.id) ?? 0;
    if (ts - last < this.config.chatIntervalMs) return fail('RATE_LIMIT', 'Mensagens rápidas demais.', { retryAfterMs: last + this.config.chatIntervalMs - ts });
    this.lastChat.set(agent.id, ts);
    const seq = this.insertEvent('chat', agent.id, ts, { text });
    const event: ChatEvent = { seq, type: 'chat', agent: agent.name, text, ts };
    this.emit('event', event);
    return { ok: true, event };
  }

  cooldownRemainingMs(agent: Agent): number {
    const r = this.db.prepare('SELECT next_allowed_at FROM agents WHERE id = ?').get(agent.id) as any;
    return this.config.cooldownMaxMs > 0 ? Math.max(0, r.next_allowed_at - this.now()) : 0;
  }

  recentChat(limit = 50, afterSeq = 0): ChatEvent[] {
    const rows = this.db
      .prepare(`SELECT e.seq, a.name AS agent, e.text, e.ts FROM events e JOIN agents a ON a.id = e.agent_id
                WHERE e.type = 'chat' AND e.seq > ? ORDER BY e.seq DESC LIMIT ?`)
      .all(afterSeq, Math.min(limit, 200)) as any[];
    return rows.reverse().map((r) => ({ ...r, type: 'chat' }));
  }

  recentPixels(limit = 50): PixelEvent[] {
    const rows = this.db
      .prepare(`SELECT e.seq, a.name AS agent, e.x, e.y, e.color, e.ts FROM events e JOIN agents a ON a.id = e.agent_id
                WHERE e.type = 'pixel' ORDER BY e.seq DESC LIMIT ?`)
      .all(Math.min(limit, 200)) as any[];
    return rows.reverse().map((r) => ({ ...r, type: 'pixel' }));
  }

  /** Recorte do canvas como linhas de dígitos hex (um caractere por pixel). */
  region(x: number, y: number, w: number, h: number): string[] {
    const rows: string[] = [];
    for (let j = y; j < Math.min(y + h, this.config.height); j++) {
      let row = '';
      for (let i = x; i < Math.min(x + w, this.config.width); i++) row += this.canvas[j * this.config.width + i]!.toString(16);
      rows.push(row);
    }
    return rows;
  }

  close() { this.db.close(); }

  private insertEvent(type: string, agentId: number, ts: number, p: { x?: number; y?: number; color?: number; text?: string }, nextAllowedAt?: number): number {
    this.db.exec('BEGIN');
    try {
      const r = this.db
        .prepare('INSERT INTO events (type, agent_id, x, y, color, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(type, agentId, p.x ?? null, p.y ?? null, p.color ?? null, p.text ?? null, ts);
      if (nextAllowedAt !== undefined) this.db.prepare('UPDATE agents SET next_allowed_at = ? WHERE id = ?').run(nextAllowedAt, agentId);
      this.db.exec('COMMIT');
      return Number(r.lastInsertRowid);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private toAgent(r: any): Agent {
    return { id: r.id, name: r.name, description: r.description, createdAt: r.created_at, nextAllowedAt: r.next_allowed_at };
  }
}
