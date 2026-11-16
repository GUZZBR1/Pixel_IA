import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, type AgentConfig } from './agent.js';
import { RateLimited } from './llm.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const CONFIG = process.env.AGENTS_CONFIG ?? fileURLToPath(new URL('../agents.json', import.meta.url));
const KEYS = fileURLToPath(new URL('../data/agent-keys.json', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(CONFIG)) { console.error(`Crie ${CONFIG} a partir de agents.example.json`); process.exit(1); }
const configs: AgentConfig[] = (() => {
  let raw: any;
  try { raw = JSON.parse(readFileSync(CONFIG, 'utf8')); }
  catch (e) { console.error(`Não consegui ler ${CONFIG}: ${(e as Error).message}`); process.exit(1); }
  if (!Array.isArray(raw) || raw.some((c: any) => !c?.name || !c?.provider?.baseUrl || !c?.provider?.model)) {
    console.error(`${CONFIG}: cada agente precisa de name, description e provider {baseUrl, model, apiKeyEnv?}`);
    process.exit(1);
  }
  return raw;
})();
mkdirSync(dirname(KEYS), { recursive: true });
const keys: Record<string, string> = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : {};

const persistKeys = () => {
  const tmp = `${KEYS}.tmp`;
  writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  renameSync(tmp, KEYS);
};

async function keyFor(c: AgentConfig): Promise<string | null> {
  if (keys[c.name]) return keys[c.name]!;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/v1/agents/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: c.name, description: c.description }),
        signal: AbortSignal.timeout(15_000),
      });
      const r = await res.json() as any;
      if (!r.success) { console.error(`[${c.name}] registro falhou: ${r.error} ${r.error === 'NAME_TAKEN' ? '(nome já existe e a chave não está em ' + KEYS + ')' : ''}`); return null; }
      keys[c.name] = r.agent.api_key;
      persistKeys();
      return keys[c.name]!;
    } catch (e) {
      console.error(`[${c.name}] servidor inacessível (${(e as Error).message.slice(0, 120)}); nova tentativa em 15s`);
      await sleep(15_000);
    }
  }
}

async function loop(c: AgentConfig, i: number) {
  await sleep(i * 1500);
  const key = await keyFor(c);
  if (!key) return;
  const agent = new Agent(c, BASE, key, undefined, undefined, fileURLToPath(new URL(`../data/state-${c.name.replace(/\W/g, '_')}.json`, import.meta.url)));
  console.log(`[${c.name}] entrou (${c.provider.model} @ ${c.provider.baseUrl})`);
  (async () => { for (;;) { try { await sleep(await agent.tick()); } catch { await sleep(5000); } } })();
  for (;;) {
    try { await sleep((await agent.step()) * 1000); }
    catch (e) {
      if ((e as Error).message === 'UNAUTHORIZED') {
        console.error(`[${c.name}] chave recusada pelo servidor; registrando de novo`);
        delete keys[c.name];
        persistKeys();
        const k = await keyFor(c);
        if (!k) return;
        agent.setApiKey(k);
        continue;
      }
      const wait = e instanceof RateLimited ? Math.min(e.retryAfterSec, 300) + Math.random() * 5 : 30;
      console.error(`[${c.name}] ${e instanceof RateLimited ? 'cota esgotada' : 'erro'}: ${(e as Error).message.slice(0, 160)} -> volta em ${Math.round(wait)}s`);
      await sleep(wait * 1000);
    }
  }
}

await Promise.all(configs.map(loop));
