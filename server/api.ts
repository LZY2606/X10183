import type { ServerResponse } from 'node:http';
import type { DB } from './db.js';
import { importTrace, parseTraceText } from './trace.js';
import { parseDbc } from './dbc.js';
import { createDbcVersion, getRules, updateEffectiveInterval } from './dbcService.js';
import { listDbcVersions, listFramesOrdered, loadDbcVersion } from './repo.js';
import { decodeFrame, decodeTimeline, decodeWithVersion, staleCount } from './decode.js';
import { analyzeCounters } from './counters.js';
import { analyzeChecksums } from './crc.js';
import {
  compareVersions,
  createMigration,
  createSnapshot,
  decideMigration,
  decodeImpact,
  getMigration,
  getSnapshot,
  listMigrations,
  listSnapshots
} from './compare.js';
import { seedDemo } from './seed.js';

export interface Req {
  method: string;
  url: URL;
  body: unknown;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

const json = (res: ServerResponse, payload: unknown) => send(res, 200, payload);
const badRequest = (res: ServerResponse, message: string, code?: string) =>
  send(res, code === 'VERSION_CONFLICT' ? 409 : 400, { error: message, code });

async function readBody(req: Req): Promise<Record<string, unknown>> {
  return (req.body ?? {}) as Record<string, unknown>;
}

export async function handleApi(db: DB, req: Req, res: ServerResponse): Promise<boolean> {
  const p = req.url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/health') return json(res, { ok: true, name: '总线刻度' }), true;

    if (req.method === 'GET' && p === '/api/state') {
      return json(res, {
        dbcs: listDbcVersions(db),
        stale: staleCount(db),
        imports: db.prepare('SELECT * FROM trace_imports ORDER BY id').all()
      }), true;
    }

    if (req.method === 'POST' && p === '/api/trace/import') {
      const body = await readBody(req);
      const name = String(body.name ?? '未命名采集');
      const frames = typeof body.text === 'string' ? parseTraceText(body.text) : (body.frames as never[] | undefined ?? []);
      const result = importTrace(db, name, frames as never);
      return json(res, result), true;
    }

    if (req.method === 'GET' && p === '/api/frames') {
      const frames = listFramesOrdered(db);
      return json(res, frames), true;
    }

    if (req.method === 'GET' && p === '/api/timeline') {
      const limit = Number(req.url.searchParams.get('limit') ?? 500);
      const offset = Number(req.url.searchParams.get('offset') ?? 0);
      return json(res, decodeTimeline(db, { limit, offset })), true;
    }

    if (p.startsWith('/api/frames/') && p.endsWith('/decode')) {
      const id = Number(p.split('/')[3]);
      const vParam = req.url.searchParams.get('dbcId');
      const decoded = vParam ? decodeWithVersion(db, Number(vParam), [id])[0] : decodeFrame(db, id);
      return json(res, decoded), true;
    }

    if (p.startsWith('/api/decode-with/')) {
      const dbcId = Number(p.split('/').pop());
      return json(res, decodeWithVersion(db, dbcId)), true;
    }

    if (req.method === 'POST' && p === '/api/dbc') {
      const body = await readBody(req);
      const source = typeof body.source === 'string' ? body.source : '';
      const dbcId = createDbcVersion(db, {
        label: String(body.label ?? ''),
        source,
        parsed: parseDbc(source),
        effectiveFrom: body.effectiveFrom === undefined ? null : (body.effectiveFrom as number | null),
        effectiveTo: body.effectiveTo === undefined ? null : (body.effectiveTo as number | null),
        counters: body.counters as never,
        checksums: body.checksums as never
      });
      return json(res, loadDbcVersion(db, dbcId)), true;
    }

    if (req.method === 'GET' && p === '/api/dbc') return json(res, listDbcVersions(db)), true;

    if (p.startsWith('/api/dbc/') && p.endsWith('/rules')) {
      const id = Number(p.split('/')[3]);
      return json(res, getRules(db, id)), true;
    }

    if (req.method === 'PATCH' && p.startsWith('/api/dbc/')) {
      const id = Number(p.split('/')[3]);
      const body = await readBody(req);
      const updated = updateEffectiveInterval(db, id, {
        effectiveFrom: body.effectiveFrom as number | null | undefined,
        effectiveTo: body.effectiveTo as number | null | undefined,
        expectedVersion: body.expectedVersion as number | undefined
      });
      return json(res, updated), true;
    }

    if (req.method === 'GET' && p === '/api/counters') return json(res, analyzeCounters(db)), true;
    if (req.method === 'GET' && p === '/api/checksums') return json(res, analyzeChecksums(db)), true;

    if (req.method === 'GET' && p.startsWith('/api/compare')) {
      const from = Number(req.url.searchParams.get('from'));
      const to = Number(req.url.searchParams.get('to'));
      const impact = req.url.searchParams.get('impact') === '1';
      return json(res, impact ? decodeImpact(db, from, to) : compareVersions(db, from, to)), true;
    }

    if (req.method === 'POST' && p === '/api/migrations') {
      const body = await readBody(req);
      return json(res, createMigration(db, Number(body.fromDbcId), Number(body.toDbcId))), true;
    }
    if (req.method === 'GET' && p === '/api/migrations') return json(res, listMigrations(db)), true;
    if (req.method === 'GET' && p.startsWith('/api/migrations/')) {
      return json(res, getMigration(db, Number(p.split('/').pop()))), true;
    }
    if (req.method === 'POST' && p.startsWith('/api/migrations/') && p.endsWith('/decision')) {
      const id = Number(p.split('/')[3]);
      const body = await readBody(req);
      const result = decideMigration(db, id, {
        status: body.status as 'approved' | 'incompatible',
        rationale: body.rationale as string | undefined,
        expectedVersion: Number(body.expectedVersion)
      });
      return json(res, result), true;
    }

    if (req.method === 'POST' && p === '/api/snapshots') {
      const body = await readBody(req);
      return json(res, createSnapshot(db, { title: String(body.title ?? '快照'), note: body.note as string })), true;
    }
    if (req.method === 'GET' && p === '/api/snapshots') return json(res, listSnapshots(db)), true;
    if (req.method === 'GET' && p.startsWith('/api/snapshots/')) {
      return json(res, getSnapshot(db, Number(p.split('/').pop()))), true;
    }

    if (req.method === 'POST' && p === '/api/seed') {
      if ((db.prepare('SELECT COUNT(*) AS c FROM trace_imports').get() as { c: number }).c > 0) {
        badRequest(res, '已有采集数据，演示种子仅可用于空仓库');
        return true;
      }
      seedDemo(db);
      return json(res, { ok: true }), true;
    }

    return false;
  } catch (err) {
    const e = err as Error & { code?: string };
    return badRequest(res, e.message, e.code), true;
  }
}
