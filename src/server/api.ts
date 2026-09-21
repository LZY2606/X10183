import type { IncomingMessage, ServerResponse } from 'node:http';
import { openDatabase } from './db.js';
import { Service, ConflictError, ValidationError, parseDbcPayload } from './service.js';
import {
  compareRevisions,
  createSnapshot,
  decideReview,
  decodeForFrame,
  getOrCreateReview,
  getSnapshot,
  getTimeline,
  listReviews,
  listSnapshots,
  runCounterCheck,
  runCrcCheck,
  signalSeries,
} from './analysis.js';
import { seedIfEmpty } from './seed.js';
import type { CounterConfig, CrcConfig, IdKind } from '../shared/types.js';

type NextFn = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: NextFn) => void;

export interface ApiOptions {
  dbPath?: string;
  seed?: boolean;
}

export function createApiMiddleware(opts: ApiOptions = {}): Middleware {
  const db = openDatabase(opts.dbPath);
  const svc = new Service(db);
  if (opts.seed ?? process.env.BUSSCALE_NO_SEED !== '1') {
    seedIfEmpty(svc);
  }

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    handle(svc, req, res, url).catch((err) => sendError(res, err));
  };
}

async function handle(
  svc: Service,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const q = url.searchParams;

  const num = (name: string): number | undefined => {
    const v = q.get(name);
    return v === null || v === '' ? undefined : Number(v);
  };

  if (method === 'GET' && path === '/api/state') {
    return send(res, 200, {
      generations: svc.listGenerations(),
      imports: svc.listImports(),
      revisions: svc.listRevisions().map((r) => ({
        id: r.id,
        label: r.label,
        revision: r.revision,
        effectiveStartMs: r.effectiveStartMs,
        effectiveEndMs: r.effectiveEndMs,
        importedAtMs: r.importedAtMs,
        messageCount: r.doc.messages.length,
        docVersion: r.doc.version ?? null,
      })),
      snapshots: listSnapshots(svc),
      reviews: listReviews(svc),
    });
  }

  if (method === 'POST' && path === '/api/trace/import') {
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text : JSON.stringify(body.frames ?? []);
    const result = svc.importTrace(text, { note: body.note });
    return send(res, 200, result);
  }

  if (method === 'GET' && path === '/api/frames') {
    return send(res, 200, svc.listFrames(frameFilter(q)));
  }

  if (method === 'GET' && path === '/api/timeline') {
    return send(res, 200, getTimeline(svc, frameFilter(q)));
  }

  const decodeMatch = path.match(/^\/api\/frames\/(\d+)\/decode$/);
  if (method === 'GET' && decodeMatch) {
    const frame = svc.getFrame(Number(decodeMatch[1]));
    if (!frame) throw new ValidationError('帧不存在');
    const revisionId = num('revisionId');
    return send(res, 200, { frame, ...decodeForFrame(svc, frame, revisionId) });
  }

  if (method === 'GET' && path === '/api/signals/series') {
    const key = q.get('key');
    const signal = q.get('signal');
    if (!key || !signal) throw new ValidationError('需要 key 与 signal 参数');
    return send(res, 200, signalSeries(svc, key, signal, num('revisionId')));
  }

  if (method === 'POST' && path === '/api/dbc/import') {
    const body = await readBody(req);
    const doc =
      body.doc ?? (typeof body.dbcText === 'string' ? parseDbcPayload(body.dbcText) : undefined);
    if (!doc) throw new ValidationError('缺少 DBC 内容（doc 或 dbcText）');
    const rev = svc.importDbc({
      label: String(body.label ?? ''),
      revision: Number(body.revision),
      effectiveStartMs: Number(body.effectiveStartMs),
      effectiveEndMs:
        body.effectiveEndMs === null || body.effectiveEndMs === undefined
          ? null
          : Number(body.effectiveEndMs),
      doc,
    });
    return send(res, 200, { id: rev.id, label: rev.label, revision: rev.revision });
  }

  if (method === 'GET' && path === '/api/dbc/revisions') {
    return send(res, 200, svc.listRevisions());
  }

  const intervalMatch = path.match(/^\/api\/dbc\/revisions\/(\d+)\/interval$/);
  if (method === 'POST' && intervalMatch) {
    const body = await readBody(req);
    const rev = svc.updateRevisionInterval(
      Number(intervalMatch[1]),
      Number(body.effectiveStartMs),
      body.effectiveEndMs === null || body.effectiveEndMs === undefined
        ? null
        : Number(body.effectiveEndMs)
    );
    return send(res, 200, rev);
  }

  if (method === 'GET' && path === '/api/checks/counter') {
    const cfg: CounterConfig = {
      node: q.get('node') ?? '',
      messageKey: q.get('key') ?? '',
      signalName: q.get('signal') ?? '',
      window: num('window') ?? null,
    };
    return send(res, 200, runCounterCheck(svc, cfg));
  }

  if (method === 'GET' && path === '/api/checks/crc') {
    const cfg: CrcConfig = {
      messageKey: q.get('key') ?? '',
      signalName: q.get('signal') ?? '',
      algo: (q.get('algo') as 'crc8' | 'sum8') ?? 'crc8',
      coverStartByte: num('coverStart') ?? null,
      coverEndByte: num('coverEnd') ?? null,
      init: num('init') ?? null,
      xorOut: num('xorOut') ?? null,
    };
    return send(res, 200, runCrcCheck(svc, cfg));
  }

  if (method === 'POST' && path === '/api/snapshots') {
    const body = await readBody(req);
    return send(res, 200, createSnapshot(svc, String(body.name ?? ''), body.note));
  }

  if (method === 'GET' && path === '/api/snapshots') {
    return send(res, 200, listSnapshots(svc));
  }

  const snapMatch = path.match(/^\/api\/snapshots\/(\d+)$/);
  if (method === 'GET' && snapMatch) {
    return send(res, 200, getSnapshot(svc, Number(snapMatch[1])));
  }

  if (method === 'GET' && path === '/api/compare') {
    const from = num('from');
    const to = num('to');
    if (from === undefined || to === undefined) throw new ValidationError('需要 from 与 to 参数');
    return send(res, 200, compareRevisions(svc, from, to));
  }

  if (method === 'GET' && path === '/api/reviews') {
    return send(res, 200, listReviews(svc));
  }

  if (method === 'POST' && path === '/api/reviews/ensure') {
    const body = await readBody(req);
    return send(
      res,
      200,
      getOrCreateReview(
        svc,
        Number(body.fromRevisionId),
        Number(body.toRevisionId),
        String(body.messageKey)
      )
    );
  }

  const decideMatch = path.match(/^\/api\/reviews\/(\d+)\/decide$/);
  if (method === 'POST' && decideMatch) {
    const body = await readBody(req);
    return send(
      res,
      200,
      decideReview(
        svc,
        Number(decideMatch[1]),
        Number(body.version),
        body.decision,
        body.mapping
      )
    );
  }

  throw new NotFoundError(`未知 API: ${method} ${path}`);
}

function frameFilter(q: URLSearchParams) {
  const numOf = (name: string) => {
    const v = q.get(name);
    return v === null || v === '' ? undefined : Number(v);
  };
  return {
    generation: q.get('generation') ?? undefined,
    channel: q.get('channel') ?? undefined,
    key: q.get('key') ?? undefined,
    fromMs: numOf('fromMs'),
    toMs: numOf('toMs'),
    limit: numOf('limit'),
  };
}

class NotFoundError extends Error {
  status = 404;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  const status =
    err instanceof ConflictError || err instanceof ValidationError || err instanceof NotFoundError
      ? err.status
      : 500;
  const message = err instanceof Error ? err.message : String(err);
  send(res, status, { error: message, status });
}

export type { IdKind };
