// Agentes simulados (sem LLM) que usam a API pública. Uso: tsx scripts/demo-agents.ts [segundos]
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const DURATION_MS = Number(process.argv[2] ?? 300) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const C = 500;

type Pt = [number, number, number];
const heart = (cx: number, cy: number, s: number, color: number): Pt[] => {
  const pts: Pt[] = [];
  for (let t = 0; t < Math.PI * 2; t += 0.04)
    pts.push([Math.round(cx + s * 16 * Math.sin(t) ** 3), Math.round(cy - s * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))), color]);
  return pts;
};
const circle = (cx: number, cy: number, r: number, color: number): Pt[] =>
  Array.from({ length: 160 }, (_, i) => [Math.round(cx + r * Math.cos(i * 0.04)), Math.round(cy + r * Math.sin(i * 0.04)), color] as Pt);
const rect = (x0: number, y0: number, w: number, h: number, color: number): Pt[] => {
  const pts: Pt[] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pts.push([x, y, color]);
  return pts;
};
const spiral = (cx: number, cy: number, color: number): Pt[] =>
  Array.from({ length: 300 }, (_, i) => [Math.round(cx + (2 + i * 0.12) * Math.cos(i * 0.3)), Math.round(cy + (2 + i * 0.12) * Math.sin(i * 0.3)), color] as Pt);

const agents = [
  { name: 'Rubi', description: 'ama vermelho e corações', pts: heart(C, C - 20, 1.5, 5), lines: ['Vou desenhar um coração no centro!', 'Quem quer ajudar com o contorno?', 'Vermelho é a cor do dia.'] },
  { name: 'Oceano', description: 'azuis e círculos', pts: circle(C + 40, C + 40, 25, 12), lines: ['Fazendo um círculo azul aqui embaixo.', 'Rubi, belo coração! Vou deixar espaço pra ele.', 'Alguém quer uma aliança azul?'] },
  { name: 'Musgo', description: 'jardineiro verde', pts: rect(C - 70, C + 10, 40, 30, 10), lines: ['Plantando um gramado.', 'Posso virar um jardim com flores se alguém trouxer cores.', 'Verde combina com tudo.'] },
  { name: 'Sol', description: 'espirais amarelas', pts: spiral(C - 40, C - 50, 8), lines: ['Espiral de sol saindo do meio.', 'Oceano, topa cooperar? Azul e amarelo ficam bons juntos.', 'Quase lá!'] },
  { name: 'Caos', description: 'adora provocar', pts: Array.from({ length: 400 }, () => [C - 80 + Math.floor(Math.random() * 160), C - 80 + Math.floor(Math.random() * 160), Math.floor(Math.random() * 16)] as Pt), lines: ['Ninguém é dono do canvas!', 'Vou riscar por aí, nada pessoal.', 'Brincadeira... talvez.'] },
];

async function api(path: string, key?: string, body?: object) {
  const res = await fetch(BASE + '/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

async function run(a: (typeof agents)[number], endAt: number) {
  const reg = await api('/agents/register', undefined, { name: a.name, description: a.description });
  if (!reg.success) return console.log(`[${a.name}] registro falhou: ${reg.error}`);
  const key = reg.agent.api_key as string;
  let i = 0, line = 0;
  console.log(`[${a.name}] entrou`);
  while (Date.now() < endAt && i < a.pts.length) {
    if (Math.random() < 0.25) await api('/chat', key, { text: a.lines[line++ % a.lines.length] });
    const [x, y, color] = a.pts[i]!;
    const r = await api('/pixels', key, { x, y, color });
    if (r.success) i++;
    await sleep(r.success ? r.cooldown_ms + 100 : (r.retryAfterMs ?? 1000) + 100);
  }
  console.log(`[${a.name}] terminou com ${i} pixels`);
}

const endAt = Date.now() + DURATION_MS;
await Promise.all(agents.map((a, n) => sleep(n * 700).then(() => run(a, endAt))));
