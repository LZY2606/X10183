import { defineConfig, type Plugin } from 'vite';
import { mkdirSync } from 'node:fs';
import { openDb, type DB } from './server/db.js';
import { handleApi, type Req } from './server/api.js';

const DB_PATH = process.env.BUS_SCALE_DB ?? 'data/bus-scale.sqlite';

function busScalePlugin(): Plugin {
  let db: DB | undefined;
  return {
    name: 'bus-scale-api',
    configureServer(server) {
      mkdirSync('data', { recursive: true });
      db ??= openDb(DB_PATH);

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/api/')) return next();
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body: unknown = {};
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
            return;
          }
        }
        const apiReq: Req = { method: req.method ?? 'GET', url, body };
        const handled = await handleApi(db!, apiReq, res);
        if (!handled) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: '未找到接口' }));
        }
      });
    }
  };
}

export default defineConfig({
  root: '.',
  plugins: [busScalePlugin()],
  server: { host: '127.0.0.1', port: 5243, strictPort: true }
});
