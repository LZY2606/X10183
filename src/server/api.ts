// 总线刻度 — Vite 开发服务器中间件（API 与前端同源，端口 5243）
import type { Plugin } from 'vite';
import { getDb, resetDb } from './db.js';
import { importFrames, listGenerations, queryFrames, type ImportFrameInput } from './frames.js';
import {
  getDecodeForFrame, queryDecodes, redecodeAll, signalSeries, staleText, unmatchedFrames
} from './decode.js';
import {
  createVersion, deleteVersion, getVersion, getVersionMessages,
  listVersions, updateVersion, VersionError
} from './versions.js';
import { counterReports, crcReports } from './analysis.js';
import { approveMigration, compareVersions, listMigrations, MigrationError } from './migrate.js';
import { createSnapshot, getSnapshot, listSnapshots } from './snapshots.js';
import { isSeeded, seed } from './seed.js';

interface ReqContext {
  params: Record<string, string>;
  body: any;
}

type Handler = (ctx: ReqContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([^/]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`
  );
  routes.push({ method, pattern, keys, handler });
}

// 健康检查 / 初始化
route('POST', '/api/seed', () => {
  const db = getDb();
  seed(db);
  return { ok: true };
});
route('GET', '/api/status', () => {
  const db = getDb();
  return {
    seeded: isSeeded(db),
    frameCount: (db.prepare('SELECT COUNT(*) c FROM frames').get() as { c: number }).c,
    versionCount: (db.prepare('SELECT COUNT(*) c FROM dbc_versions').get() as { c: number }).c,
    decodeCount: (db.prepare('SELECT COUNT(*) c FROM decodes').get() as { c: number }).c
  };
});
route('POST', '/api/reset', () => {
  resetDb();
  return { ok: true };
});

// trace 导入
route('POST', '/api/imports', ({ body }) => {
  const frames: ImportFrameInput[] = body.frames ?? [];
  return importFrames(getDb(), frames, body.label);
});
route('GET', '/api/generations', () => listGenerations(getDb()));
route('GET', '/api/frames', (ctx) => {
  const q = readQuery(ctx.params);
  return queryFrames(getDb(), q);
});

// DBC 版本
route('GET', '/api/versions', () => listVersions(getDb()));
route('POST', '/api/versions', ({ body }) => createVersion(getDb(), body));
route('GET', '/api/versions/:id', ({ params }) => ({
  version: getVersion(getDb(), Number(params.id)),
  messages: getVersionMessages(getDb(), Number(params.id))
}));
route('PUT', '/api/versions/:id', ({ params, body }) =>
  updateVersion(getDb(), Number(params.id), Number(body.expectedRevision), body)
);
route('DELETE', '/api/versions/:id', ({ params, body }) => {
  deleteVersion(getDb(), Number(params.id), Number(body.expectedRevision));
  return { ok: true };
});

// 解码
route('POST', '/api/redecode', () => redecodeAll(getDb()));
route('GET', '/api/decodes', (ctx) => queryDecodes(getDb(), readQuery(ctx.params)));
route('GET', '/api/decodes/frame/:frameId', ({ params }) =>
  getDecodeForFrame(getDb(), Number(params.frameId))
);
route('GET', '/api/unmatched', () => unmatchedFrames(getDb()));
route('GET', '/api/series', (ctx) => {
  const p = ctx.params;
  return signalSeries(
    getDb(),
    Number(p.arbId),
    (p.idKind ?? 'std') as 'std' | 'ext',
    decodeURIComponent(p.signal),
    p.generation !== undefined ? Number(p.generation) : undefined
  );
});
route('GET', '/api/stale-text', () => ({
  'message-removed': staleText('message-removed'),
  moved: staleText('moved'),
  changed: staleText('changed')
}));

// 分析
route('GET', '/api/analysis/counters', (ctx) =>
  counterReports(getDb(), {
    generation: ctx.params.generation !== undefined ? Number(ctx.params.generation) : undefined
  })
);
route('GET', '/api/analysis/crc', (ctx) =>
  crcReports(getDb(), {
    generation: ctx.params.generation !== undefined ? Number(ctx.params.generation) : undefined
  })
);

// 版本对比 / 迁移
route('GET', '/api/compare/:a/:b', ({ params }) =>
  compareVersions(getDb(), Number(params.a), Number(params.b))
);
route('POST', '/api/migrations', ({ body }) => approveMigration(getDb(), body));
route('GET', '/api/migrations', () => listMigrations(getDb()));

// 调查快照
route('POST', '/api/snapshots', ({ body }) => createSnapshot(getDb(), body.label));
route('GET', '/api/snapshots', () => listSnapshots(getDb()));
route('GET', '/api/snapshots/:id', ({ params }) => getSnapshot(getDb(), Number(params.id)));

function readQuery(p: Record<string, string>) {
  return {
    generation: p.generation !== undefined ? Number(p.generation) : undefined,
    arbId: p.arbId !== undefined ? toId(p.arbId) : undefined,
    idKind: p.idKind as 'std' | 'ext' | undefined,
    channel: p.channel !== undefined ? Number(p.channel) : undefined,
    staleOnly: p.staleOnly === 'true' || p.staleOnly === '1',
    limit: p.limit !== undefined ? Number(p.limit) : undefined
  };
}

function toId(s: string): number {
  const t = decodeURIComponent(s);
  if (/^0x/i.test(t)) return parseInt(t, 16);
  return Number(t);
}

export function apiPlugin(): Plugin {
  return {
    name: 'busscale-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/api/')) return next();

        // query -> params
        const params: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          params[k] = v;
        });

        let body: any = {};
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
          const raw = await readBody(req);
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch {
              res.statusCode = 400;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
              return;
            }
          }
        }

        const match = routes.find(
          (r) => r.method === req.method && r.pattern.test(url.pathname)
        );
        if (!match) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: `无此 API：${req.method} ${url.pathname}` }));
          return;
        }
        const m = url.pathname.match(match.pattern)!;
        match.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1]);
        });

        try {
          const data = await match.handler({ params, body });
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(data ?? { ok: true }));
        } catch (err) {
          const status = err instanceof VersionError || err instanceof MigrationError ? 409 : 400;
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              code: err instanceof VersionError || err instanceof MigrationError ? 'conflict' : 'bad-request'
            })
          );
        }
      });
    }
  };
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体过大（>8MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
