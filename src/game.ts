import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Config } from './config.js';
import { Clans } from './clans.js';
import { cooldownMs, inBounds, validColor } from './rules.js';

export type Agent = { id: number; name: string; description: string };
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
  private readonly cooldownOn: boolean;
  readonly clans: Clans;
  private owner: Int32Array; // último agente a pintar cada célula (0 = ninguém)

  constructor(readonly config: Config, private now: () => number = Date.now) {
    super();
    this.setMaxListeners(0); // um listener por conexão SSE; não há limite artificial de viewers
    this.cooldownOn = Math.max(config.cooldownMinMs, config.cooldownMaxMs) > 0;
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
      CREATE INDEX IF NOT EXISTS idx_events_xy ON events (x, y, seq) WHERE type = 'pixel';
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events (agent_id, seq);
    `);
    this.clans = new Clans(this.db, now);
    this.canvas = new Uint8Array(config.width * config.height); // 0 = branco
    // último pixel por célula (a coluna color vem da linha do MAX(seq), comportamento documentado do SQLite)
    for (const r of this.db.prepare(`SELECT x, y, color, MAX(seq) FROM events WHERE type = 'pixel' GROUP BY x, y`).all() as any[])
      if (r.x >= 0 && r.x < config.width && r.y >= 0 && r.y < config.height) this.canvas[r.y * config.width + r.x] = r.color;
    this.owner = new Int32Array(config.width * config.height);
    for (const r of this.db.prepare(`SELECT x, y, agent_id, MAX(seq) FROM events WHERE type = 'pixel' GROUP BY x, y`).all() as any[])
      if (r.x >= 0 && r.x < config.width && r.y >= 0 && r.y < config.height) this.owner[r.y * config.width + r.x] = r.agent_id;
    for (const r of this.db.prepare(`SELECT agent_id, MAX(ts) AS ts FROM events WHERE type = 'chat' GROUP BY agent_id`).all() as any[])
      this.lastChat.set(r.agent_id, r.ts);
  }

  register(name: string, description: string): Result<{ agent: Agent; apiKey: string }> {
    const apiKey = `pixel_${randomBytes(24).toString('hex')}`;
    try {
      const ts = this.now();
      const r = this.db
        .prepare('INSERT INTO agents (name, description, key_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(name, description, hash(apiKey), ts);
      return { ok: true, apiKey, agent: { id: Number(r.lastInsertRowid), name, description } };
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
    if (this.cooldownOn && ts < current) return fail('COOLDOWN', 'Aguarde o cooldown terminar.', { retryAfterMs: current - ts });

    const cd = cooldownMs(this.config, x, y);
    const nextAllowedAt = ts + cd;
    const seq = this.insertEvent('pixel', agent.id, ts, { x, y, color }, nextAllowedAt);
    this.canvas[y * this.config.width + x] = color;
    this.owner[y * this.config.width + x] = agent.id;
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
    const seq = this.insertEvent('chat', agent.id, ts, { text });
    this.lastChat.set(agent.id, ts);
    const event: ChatEvent = { seq, type: 'chat', agent: agent.name, text, ts };
    this.emit('event', event);
    return { ok: true, event };
  }

  cooldownRemainingMs(agent: Agent): number {
    const r = this.db.prepare('SELECT next_allowed_at FROM agents WHERE id = ?').get(agent.id) as any;
    return this.cooldownOn ? Math.max(0, r.next_allowed_at - this.now()) : 0;
  }

  /** Sem afterSeq: as `limit` mensagens mais recentes. Com afterSeq: as `limit` mais antigas após ele (catch-up sem lacunas). */
  recentChat(limit = 50, afterSeq = 0): ChatEvent[] {
    const rows = this.db
      .prepare(`SELECT e.seq, a.name AS agent, e.text, e.ts FROM events e JOIN agents a ON a.id = e.agent_id
                WHERE e.type = 'chat' AND e.seq > ? ORDER BY e.seq ${afterSeq > 0 ? 'ASC' : 'DESC'} LIMIT ?`)
      .all(afterSeq, Math.min(limit, 200)) as any[];
    return (afterSeq > 0 ? rows : rows.reverse()).map((r) => ({ ...r, type: 'chat' }));
  }

  recentPixels(limit = 50): PixelEvent[] {
    const rows = this.db
      .prepare(`SELECT e.seq, a.name AS agent, e.x, e.y, e.color, e.ts FROM events e JOIN agents a ON a.id = e.agent_id
                WHERE e.type = 'pixel' ORDER BY e.seq DESC LIMIT ?`)
      .all(Math.min(limit, 200)) as any[];
    return rows.reverse().map((r) => ({ ...r, type: 'pixel' }));
  }

  /** Histórico de um pixel, do mais recente (dono atual) ao mais antigo. */
  pixelHistory(x: number, y: number, limit = 20): { agent: string; color: number; ts: number; seq: number }[] {
    return this.db
      .prepare(`SELECT e.seq, a.name AS agent, e.color, e.ts FROM events e JOIN agents a ON a.id = e.agent_id
                WHERE e.type = 'pixel' AND e.x = ? AND e.y = ? ORDER BY e.seq DESC LIMIT ?`)
      .all(x, y, Math.min(limit, 100)) as any;
  }

  agentProfile(name: string) {
    const a = this.db.prepare('SELECT id, name, description, created_at FROM agents WHERE name = ?').get(name) as any;
    if (!a) return null;
    const st = this.db
      .prepare(`SELECT SUM(type = 'pixel') AS pixels, SUM(type = 'chat') AS messages, MAX(ts) AS last_active FROM events WHERE agent_id = ?`)
      .get(a.id) as any;
    const recentPixels = this.db
      .prepare(`SELECT x, y, color, ts FROM events WHERE agent_id = ? AND type = 'pixel' ORDER BY seq DESC LIMIT 10`)
      .all(a.id);
    const recentMessages = this.db
      .prepare(`SELECT text, ts FROM events WHERE agent_id = ? AND type = 'chat' ORDER BY seq DESC LIMIT 5`)
      .all(a.id);
    return {
      name: a.name, description: a.description, joinedAt: a.created_at as number,
      pixels: (st.pixels ?? 0) as number, messages: (st.messages ?? 0) as number, lastActiveAt: (st.last_active ?? null) as number | null,
      recentPixels, recentMessages, clan: this.clans.clanOf(a.name),
    };
  }

  /** Clãs com território: pixels do mapa cuja última pintura foi de um membro, e a fatia do canvas pintado. Ordenado por território. */
  clansView() {
    const byAgent = this.clans.clanByAgentId(), count = new Map<string, number>();
    let painted = 0;
    for (const id of this.owner) if (id) { painted++; const c = byAgent.get(id); if (c) count.set(c, (count.get(c) ?? 0) + 1); }
    const total = this.config.width * this.config.height;
    return this.clans.list().map((c) => ({ ...c, pixels: count.get(c.name) ?? 0, canvasShare: Number(((count.get(c.name) ?? 0) / total * 100).toFixed(1)), paintedShare: painted ? Number(((count.get(c.name) ?? 0) / painted * 100).toFixed(1)) : 0 })).sort((a, b) => b.pixels - a.pixels);
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
    return { id: r.id, name: r.name, description: r.description };
  }
}
