export type Provider = { baseUrl: string; apiKeyEnv?: string; model: string };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
export type Tool = { type: 'function'; function: { name: string; description: string; parameters: object } };

export class RateLimited extends Error { constructor(readonly retryAfterSec: number, msg: string) { super(msg); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chat completion compatível com a OpenAI (OpenRouter, Groq, Gemini, 9Router, Ollama...). */
export async function chat(p: Provider, messages: Msg[], tools: Tool[]): Promise<Msg> {
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.apiKeyEnv && !key) throw new Error(`variável ${p.apiKeyEnv} não definida`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(p.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: p.model, messages, tools, tool_choice: 'auto', stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 429 || res.status >= 500) {
      const retry = Number(res.headers.get('retry-after')) || 5 * 2 ** attempt;
      if (res.status === 429 || retry > 30 || attempt >= 2) throw new RateLimited(retry, `LLM ${res.status} (cota/limite), retry em ${retry}s: ${(await res.text()).slice(0, 120)}`);
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const msg = (await res.json() as any).choices?.[0]?.message;
    if (!msg) throw new Error('resposta do LLM sem message');
    return msg as Msg;
  }
}
