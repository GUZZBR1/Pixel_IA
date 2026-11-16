import type { DatabaseSync } from 'node:sqlite';

export type Relation = 'alliance' | 'war' | 'neutral';
type Fail = { ok: false; code: string; message: string };
type Ok<T> = { ok: true } & T;
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });
const NAME = /^[A-Za-z0-9_-]{2,24}$/;
const MAX_INVITES = 10;

/** Clãs são só alianças entre agentes: sem território, cor ou efeito mecânico no canvas. */
export class Clans {
  constructor(private db: DatabaseSync, private now: () => number) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        founder_id INTEGER NOT NULL REFERENCES agents(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clan_members (
        agent_id INTEGER PRIMARY KEY REFERENCES agents(id),
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clan_invites (
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        agent_id INTEGER NOT NULL REFERENCES agents(id),
        ts INTEGER NOT NULL,
        PRIMARY KEY (clan_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS clan_goals (
        clan_id INTEGER PRIMARY KEY REFERENCES clans(id),
        goal TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clan_relations (
        a_id INTEGER NOT NULL, b_id INTEGER NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, proposer_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY (a_id, b_id)
      );
    `);
  }

  private clanOfId(agentId: number): { id: number; name: string; founder_id: number } | undefined {
    return this.db.prepare('SELECT c.id, c.name, c.founder_id FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.agent_id = ?').get(agentId) as any;
  }

  clanOf(agentName: string): string | null {
    const a = this.db.prepare('SELECT id FROM agents WHERE name = ?').get(agentName) as any;
    return (a && this.clanOfId(a.id)?.name) ?? null;
  }

  create(agentId: number, name: string, description = ''): Ok<{ clan: string }> | Fail {
    if (!NAME.test(name)) return fail('INVALID_INPUT', 'Nome do clã: 2 a 24 caracteres (letras, números, _ ou -).');
    if (this.clanOfId(agentId)) return fail('ALREADY_IN_CLAN', 'Você já está em um clã. Saia antes de criar outro.');
    try {
      const ts = this.now();
      const r = this.db.prepare('INSERT INTO clans (name, description, founder_id, created_at) VALUES (?, ?, ?, ?)').run(name, description.slice(0, 200), agentId, ts);
      this.db.prepare('INSERT INTO clan_members (agent_id, clan_id, joined_at) VALUES (?, ?, ?)').run(agentId, Number(r.lastInsertRowid), ts);
      return { ok: true, clan: name };
    } catch (e: any) {
      if (/UNIQUE/.test(String(e?.message))) return fail('NAME_TAKEN', 'Já existe um clã com esse nome.');
      throw e;
    }
  }

  /** Só o fundador convida. */
  invite(agentId: number, targetName: string): Ok<{ clan: string; invited: string }> | Fail {
    const mine = this.clanOfId(agentId);
    if (!mine) return fail('NOT_IN_CLAN', 'Você não está em um clã.');
    if (mine.founder_id !== agentId) return fail('FORBIDDEN', 'Só o fundador pode convidar.');
    const t = this.db.prepare('SELECT id, name FROM agents WHERE name = ?').get(targetName) as any;
    if (!t) return fail('NOT_FOUND', 'Agente não encontrado.');
    if (this.clanOfId(t.id)) return fail('ALREADY_IN_CLAN', 'Esse agente já está em um clã.');
    const pending = (this.db.prepare('SELECT COUNT(*) AS n FROM clan_invites WHERE clan_id = ?').get(mine.id) as any).n;
    if (pending >= MAX_INVITES) return fail('RATE_LIMIT', `Máximo de ${MAX_INVITES} convites pendentes por clã.`);
    this.db.prepare('INSERT OR REPLACE INTO clan_invites (clan_id, agent_id, ts) VALUES (?, ?, ?)').run(mine.id, t.id, this.now());
    return { ok: true, clan: mine.name, invited: t.name };
  }

  accept(agentId: number, clanName: string): Ok<{ clan: string }> | Fail {
    if (this.clanOfId(agentId)) return fail('ALREADY_IN_CLAN', 'Você já está em um clã.');
    const c = this.db.prepare('SELECT id, name FROM clans WHERE name = ?').get(clanName) as any;
    const inv = c && this.db.prepare('SELECT 1 FROM clan_invites WHERE clan_id = ? AND agent_id = ?').get(c.id, agentId);
    if (!inv) return fail('NOT_INVITED', 'Você não tem convite desse clã.');
    this.db.prepare('INSERT INTO clan_members (agent_id, clan_id, joined_at) VALUES (?, ?, ?)').run(agentId, c.id, this.now());
    this.db.prepare('DELETE FROM clan_invites WHERE agent_id = ?').run(agentId);
    return { ok: true, clan: c.name };
  }

  /** Se o fundador sai, o membro mais antigo assume; se era o último, o clã é dissolvido. */
  leave(agentId: number): Ok<{ clan: string; dissolved: boolean }> | Fail {
    const mine = this.clanOfId(agentId);
    if (!mine) return fail('NOT_IN_CLAN', 'Você não está em um clã.');
    this.db.prepare('DELETE FROM clan_members WHERE agent_id = ?').run(agentId);
    const next = this.db.prepare('SELECT agent_id FROM clan_members WHERE clan_id = ? ORDER BY joined_at, agent_id LIMIT 1').get(mine.id) as any;
    if (next) {
      if (mine.founder_id === agentId) this.db.prepare('UPDATE clans SET founder_id = ? WHERE id = ?').run(next.agent_id, mine.id);
      return { ok: true, clan: mine.name, dissolved: false };
    }
    this.db.prepare('DELETE FROM clan_invites WHERE clan_id = ?').run(mine.id);
    this.db.prepare('DELETE FROM clan_relations WHERE a_id = ? OR b_id = ?').run(mine.id, mine.id);
    this.db.prepare('DELETE FROM clans WHERE id = ?').run(mine.id);
    return { ok: true, clan: mine.name, dissolved: true };
  }

  /** Só o fundador: meta/missão do clã, visível a todos. */
  setGoal(agentId: number, goal: string): Ok<{ clan: string; goal: string }> | Fail {
    const mine = this.clanOfId(agentId);
    if (!mine) return fail('NOT_IN_CLAN', 'Você não está em um clã.');
    if (mine.founder_id !== agentId) return fail('FORBIDDEN', 'Só o fundador define o objetivo do clã.');
    goal = goal.trim().slice(0, 300);
    if (!goal) this.db.prepare('DELETE FROM clan_goals WHERE clan_id = ?').run(mine.id);
    else this.db.prepare('INSERT OR REPLACE INTO clan_goals (clan_id, goal, ts) VALUES (?, ?, ?)').run(mine.id, goal, this.now());
    return { ok: true, clan: mine.name, goal };
  }

  /** agent_id -> nome do clã, para somar território. */
  clanByAgentId(): Map<number, string> {
    return new Map((this.db.prepare('SELECT m.agent_id, c.name FROM clan_members m JOIN clans c ON c.id = m.clan_id').all() as any[]).map((r) => [r.agent_id, r.name]));
  }

  /** Só o fundador. alliance exige que o outro clã também declare; war e neutral valem na hora. */
  setRelation(agentId: number, otherName: string, kind: Relation): Ok<{ clan: string; with: string; kind: Relation; status: string }> | Fail {
    const mine = this.clanOfId(agentId);
    if (!mine) return fail('NOT_IN_CLAN', 'Você não está em um clã.');
    if (mine.founder_id !== agentId) return fail('FORBIDDEN', 'Só o fundador define relações entre clãs.');
    const o = this.db.prepare('SELECT id, name FROM clans WHERE name = ?').get(otherName) as any;
    if (!o) return fail('NOT_FOUND', 'Clã não encontrado.');
    if (o.id === mine.id) return fail('INVALID_INPUT', 'Escolha outro clã.');
    const [a, b] = mine.id < o.id ? [mine.id, o.id] : [o.id, mine.id];
    const cur = this.db.prepare('SELECT * FROM clan_relations WHERE a_id = ? AND b_id = ?').get(a, b) as any;
    const ts = this.now();
    const put = (k: string, status: string) => this.db.prepare('INSERT OR REPLACE INTO clan_relations (a_id, b_id, kind, status, proposer_id, ts) VALUES (?, ?, ?, ?, ?, ?)').run(a, b, k, status, mine.id, ts);
    let status = 'active';
    if (kind === 'neutral') this.db.prepare('DELETE FROM clan_relations WHERE a_id = ? AND b_id = ?').run(a, b);
    else if (kind === 'war') put('war', 'active');
    else if (cur?.kind === 'alliance' && cur.status === 'pending' && cur.proposer_id !== mine.id) put('alliance', 'active');
    else { put('alliance', 'pending'); status = 'pending'; }
    return { ok: true, clan: mine.name, with: o.name, kind, status: kind === 'neutral' ? 'none' : status };
  }

  list() {
    const clans = this.db.prepare('SELECT c.id, c.name, c.description, f.name AS founder, c.created_at FROM clans c JOIN agents f ON f.id = c.founder_id ORDER BY c.id').all() as any[];
    const members = this.db.prepare('SELECT m.clan_id, a.name FROM clan_members m JOIN agents a ON a.id = m.agent_id ORDER BY m.joined_at, a.id').all() as any[];
    const rels = this.db.prepare('SELECT * FROM clan_relations').all() as any[];
    const goals = new Map((this.db.prepare('SELECT clan_id, goal FROM clan_goals').all() as any[]).map((g) => [g.clan_id, g.goal as string]));
    const nameOf = new Map(clans.map((c) => [c.id, c.name as string]));
    return clans.map((c) => ({
      name: c.name as string, description: c.description as string, founder: c.founder as string, createdAt: c.created_at as number,
      goal: goals.get(c.id) ?? null,
      members: members.filter((m) => m.clan_id === c.id).map((m) => m.name as string),
      relations: rels.filter((r) => r.a_id === c.id || r.b_id === c.id).map((r) => {
        const other = nameOf.get(r.a_id === c.id ? r.b_id : r.a_id)!;
        return { with: other, kind: r.kind as 'alliance' | 'war', status: r.status as 'active' | 'pending', proposedByYou: r.proposer_id === c.id };
      }),
    }));
  }

  invitesFor(agentId: number): string[] {
    return (this.db.prepare('SELECT c.name FROM clan_invites i JOIN clans c ON c.id = i.clan_id WHERE i.agent_id = ? ORDER BY i.ts').all(agentId) as any[]).map((r) => r.name);
  }
}
