import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseDbc } from '../core/dbc-parse';
import { parseTrace } from '../core/trace-parse';
import { importTrace } from './db';
import {
  addVersion,
  compareVersions,
  counterReport,
  crcReport,
  createInvestigation,
  decideMigration,
  decodeFrame,
  getInvestigation,
  getVersionDoc,
  listBatches,
  listFrames,
  listInvestigations,
  listMigrations,
  listVersions,
  proposeMigration,
  updateVersionInterval,
} from './services';

type Json = unknown;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: Json) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, body: any, url: URL) => Json | Promise<Json>;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: () => ({ ok: true, name: '总线刻度' }) },
  { method: 'GET', pattern: /^\/api\/batches$/, handler: () => listBatches() },
  { method: 'GET', pattern: /^\/api\/frames$/, handler: (_p, _b, url) => {
      const q = url.searchParams;
      return listFrames({
        batchId: q.has('batchId') ? Number(q.get('batchId')) : undefined,
        arbId: q.has('arbId') ? Number(q.get('arbId')) : undefined,
        extended: q.has('extended') ? q.get('extended') === 'true' : undefined,
        generation: q.has('generation') ? Number(q.get('generation')) : undefined,
        limit: q.has('limit') ? Number(q.get('limit')) : undefined,
      });
    },
  },
  { method: 'GET', pattern: /^\/api\/frames\/(\d+)\/decode$/, handler: (p, _b, url) =>
      decodeFrame(Number(p[0]), url.searchParams.has('versionId') ? Number(url.searchParams.get('versionId')) : undefined),
  },
  { method: 'POST', pattern: /^\/api\/traces\/import$/, handler: (_p, body) => {
      const text = typeof body.text === 'string' ? body.text : JSON.stringify(body.frames);
      const frames = parseTrace(text);
      return importTrace(body.name ?? `trace-${new Date().toISOString()}`, frames);
    },
  },
  { method: 'GET', pattern: /^\/api\/dbc\/versions$/, handler: () => listVersions() },
  { method: 'GET', pattern: /^\/api\/dbc\/versions\/(\d+)$/, handler: (p) => getVersionDoc(Number(p[0])) },
  { method: 'POST', pattern: /^\/api\/dbc\/versions$/, handler: (_p, body) => {
      if (body.dbcText) {
        const doc = parseDbc(body.dbcText, { rules: body.rules, channel: body.channel ?? null });
        return addVersion({ label: body.label, startNs: Number(body.startNs), endNs: body.endNs == null ? null : Number(body.endNs), doc });
      }
      return addVersion({
        label: String(body.label),
        startNs: Number(body.startNs),
        endNs: body.endNs == null ? null : Number(body.endNs),
        doc: body.doc,
      });
    },
  },
  { method: 'PATCH', pattern: /^\/api\/dbc\/versions\/(\d+)$/, handler: (p, body) =>
      updateVersionInterval(Number(p[0]), {
        startNs: body.startNs,
        endNs: body.endNs,
        expectedRowVersion: Number(body.expectedRowVersion),
      }),
  },
  { method: 'GET', pattern: /^\/api\/counters$/, handler: () => counterReport() },
  { method: 'GET', pattern: /^\/api\/crcs$/, handler: () => crcReport() },
  { method: 'GET', pattern: /^\/api\/compare$/, handler: (_p, _b, url) =>
      compareVersions(
        Number(url.searchParams.get('from')),
        Number(url.searchParams.get('to')),
        url.searchParams.has('batchId') ? Number(url.searchParams.get('batchId')) : undefined,
      ),
  },
  { method: 'POST', pattern: /^\/api\/migrations$/, handler: (_p, body) =>
      proposeMigration(Number(body.fromVersionId), Number(body.toVersionId), Number(body.arbId), Boolean(body.extended)),
  },
  { method: 'GET', pattern: /^\/api\/migrations$/, handler: () => listMigrations() },
  { method: 'POST', pattern: /^\/api\/migrations\/(\d+)\/decision$/, handler: (p, body) =>
      decideMigration(
        Number(p[0]),
        body.decision === 'incompatible' ? 'incompatible' : 'approved',
        body.mapping ?? null,
        Number(body.expectedRowVersion),
      ),
  },
  { method: 'POST', pattern: /^\/api\/investigations$/, handler: (_p, body) =>
      createInvestigation({
        name: String(body.name),
        note: body.note,
        frameIds: body.frameIds.map(Number),
        versionIdOverride: body.versionIdOverride ?? null,
      }),
  },
  { method: 'GET', pattern: /^\/api\/investigations$/, handler: () => listInvestigations() },
  { method: 'GET', pattern: /^\/api\/investigations\/(\d+)$/, handler: (p) => getInvestigation(Number(p[0])) },
];

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) {
      send(res, 404, { error: `未找到路由 ${req.method} ${url.pathname}` });
      return true;
    }
    const match = url.pathname.match(route.pattern)!;
    const params = Object.fromEntries(match.slice(1).map((v, i) => [String(i), v]));
    let body: any = {};
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    }
    const result = await route.handler(params, body, url);
    send(res, 200, result ?? { ok: true });
  } catch (err: any) {
    send(res, err.status ?? 400, { error: err.message ?? String(err) });
  }
  return true;
}
