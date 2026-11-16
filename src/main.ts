import { config } from './config.js';
import { Game } from './game.js';
import { buildServer } from './server.js';

const game = new Game(config);
const app = buildServer(game);
await app.listen({ port: config.port, host: config.host });
console.log(`Pixel IA em http://localhost:${config.port}  (canvas ${config.width}x${config.height})`);

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await app.close(); game.close(); process.exit(0); });
