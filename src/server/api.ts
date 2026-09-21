import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ConflictError,
  compareVersions,
  counterReports,
  crcEvidence,
  createDbcVersion,
  createMigration,
  createSnapshot,
  decodeTrace,
  getSnapshot,
  importTrace,
  listDecoded,
  listDbcVersions,
  listFrames,
  listMigrations,
  listTraces,
  openDb,
  setMigrationStatus,
  type DB,
} from './store';
import { seedDemo } from './demo';
import type { CanFrame, DbcDef } from '../core/types';

export interface ApiContext {
  db: DB;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

export function createApiHandler(dbPath: string) {
  const ctx: ApiContext = { db: openDb(dbPath) };
  return async function handler(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    try {
      const body = req.method === 'POST' ? ((await readBody(req)) as Record<string, unknown>) : {};
      const result = await route(ctx, req.method ?? 'GET', url.pathname, url, body);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        sendJson(res, 500, { error: String((err as Error).message ?? err) });
      }
    }
  };
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function num(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ApiError(400, `invalid ${name}`);
  return n;
}

async function route(
  ctx: ApiContext,
  method: string,
  path: string,
  url: URL,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { db } = ctx;
  const seg = path.split('/').filter(Boolean).slice(1); // strip "api"

  if (method === 'GET' && path === '/api/health') return { ok: true, app: '总线刻度' };

  if (method === 'GET' && path === '/api/traces') return listTraces(db);
  if (method === 'POST' && path === '/api/traces') {
    const frames = body.frames as CanFrame[];
    if (!Array.isArray(frames)) throw new ApiError(400, 'frames required');
    const id = importTrace(db, String(body.name ?? 'trace'), frames);
    return { trace_id: id, frames: frames.length };
  }
  if (method === 'GET' && seg[0] === 'traces' && seg[2] === 'frames') {
    return listFrames(db, num(seg[1], 'trace_id'));
  }
  if (method === 'POST' && seg[0] === 'traces' && seg[2] === 'decode') {
    const traceId = num(seg[1], 'trace_id');
    return { decoded: decodeTrace(db, traceId) };
  }
  if (method === 'GET' && seg[0] === 'traces' && seg[2] === 'decoded') {
    return listDecoded(db, num(seg[1], 'trace_id'));
  }
  if (method === 'GET' && seg[0] === 'traces' && seg[2] === 'counters') {
    return counterReports(db, num(seg[1], 'trace_id'));
  }
  if (method === 'GET' && seg[0] === 'traces' && seg[2] === 'crc') {
    return crcEvidence(db, num(seg[1], 'trace_id'));
  }

  if (method === 'GET' && path === '/api/dbc-versions') {
    return listDbcVersions(db).map((v) => ({ ...v, content: undefined }));
  }
  if (method === 'POST' && path === '/api/dbc-versions') {
    const id = createDbcVersion(db, {
      name: String(body.name ?? 'dbc'),
      effective_from: num(body.effective_from, 'effective_from'),
      effective_to: body.effective_to === null || body.effective_to === undefined
        ? null
        : num(body.effective_to, 'effective_to'),
      content: body.content as DbcDef,
    });
    return { dbc_version_id: id };
  }

  if (method === 'GET' && path === '/api/compare') {
    const result = compareVersions(
      db,
      num(url.searchParams.get('trace_id'), 'trace_id'),
      num(url.searchParams.get('a'), 'a'),
      num(url.searchParams.get('b'), 'b'),
    );
    if (!result) throw new ApiError(404, 'version not found');
    return result;
  }

  if (method === 'GET' && path === '/api/migrations') return listMigrations(db);
  if (method === 'POST' && path === '/api/migrations') {
    const id = createMigration(db, {
      from_version_id: num(body.from_version_id, 'from_version_id'),
      to_version_id: num(body.to_version_id, 'to_version_id'),
      trace_id: num(body.trace_id, 'trace_id'),
      mapping: body.mapping ?? {},
    });
    return { migration_id: id };
  }
  if (method === 'POST' && seg[0] === 'migrations' && (seg[2] === 'approve' || seg[2] === 'incompatible')) {
    try {
      setMigrationStatus(
        db,
        num(seg[1], 'migration_id'),
        num(body.version, 'version'),
        seg[2] === 'approve' ? 'approved' : 'incompatible',
      );
    } catch (err) {
      if (err instanceof ConflictError) throw new ApiError(409, err.message);
      throw err;
    }
    return { ok: true };
  }

  if (method === 'POST' && path === '/api/snapshots') {
    const id = createSnapshot(db, num(body.trace_id, 'trace_id'), String(body.name ?? 'snapshot'));
    return { snapshot_id: id };
  }
  if (method === 'GET' && seg[0] === 'snapshots' && seg[1]) {
    const snap = getSnapshot(db, num(seg[1], 'snapshot_id'));
    if (!snap) throw new ApiError(404, 'snapshot not found');
    return snap;
  }

  if (method === 'POST' && path === '/api/demo') return seedDemo(db);

  throw new ApiError(404, `no route: ${method} ${path}`);
}
