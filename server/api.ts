import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseDbc, diffMessages, effectiveAt } from '../src/core/dbc.js';
import {
  getMessages,
  insertDbc,
  insertFrames,
  insertParsedDbc,
  listCounterRules,
  listCrcRules,
  listDbcs,
  listFrames,
  listMigrations,
  listSnapshots,
  getSnapshot,
  saveSnapshot,
  upsertCounterRule,
  upsertCrcRule,
  upsertMigration,
  updateMigrationStatus,
  getDbc
} from './repo.js';
import { buildContext, counterReports, crcReports, frozenReplay, replayAll, replayOne } from './engine.js';
import { seed } from './seed.js';

async function readBody(req: IncomingMessage): Promise<any> {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function frameTimeline() {
  return replayAll().map((d) => ({
    id: d.frame.id,
    canId: d.frame.canId,
    isExtended: d.frame.isExtended,
    channel: d.frame.channel,
    hwTime: d.frame.hwTime,
    acquisitionGen: d.frame.acquisitionGen,
    dataHex: d.frame.dataHex,
    dbcId: d.dbc?.id ?? null,
    dbcLabel: d.dbc?.label ?? null,
    messageName: d.message?.name ?? null,
    reason: d.reason,
    muxValue: d.muxValue,
    signalCount: d.signals.length,
    stale: false
  }));
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;

  try {
    if (path === '/api/state' && req.method === 'GET') {
      send(res, 200, {
        dbcs: listDbcs(),
        counterRules: listCounterRules(),
        crcRules: listCrcRules(),
        snapshots: listSnapshots(),
        frameCount: listFrames().length
      });
      return true;
    }

    if (path === '/api/seed' && req.method === 'POST') {
      const ids = seed();
      send(res, 200, { ok: true, ...ids });
      return true;
    }

    if (path === '/api/frames' && req.method === 'POST') {
      const body = await readBody(req);
      const count = insertFrames(body.frames);
      send(res, 200, { ok: true, count });
      return true;
    }

    if (path === '/api/trace-import' && req.method === 'POST') {
      // 文本导入：CSV canid,ext,channel,time,data,gen（带表头可选）
      const body = await readBody(req);
      const text: string = body.text ?? '';
      const frames: any[] = [];
      for (const line0 of text.split(/\r?\n/)) {
        const line = line0.trim();
        if (!line || line.toLowerCase().startsWith('canid')) continue;
        const cols = line.split(/[,\s]+/).filter(Boolean);
        if (cols.length < 6) continue;
        const idTok = cols[0];
        const isExtended = idTok.toLowerCase().endsWith('x') || cols[1] === '1' || cols[1].toLowerCase() === 'ext';
        const canId = parseInt(idTok.replace(/x$/i, '').replace(/^0x/i, ''), idTok.toLowerCase().startsWith('0x') ? 16 : 10);
        frames.push({
          canId,
          isExtended,
          channel: parseInt(cols[2], 10),
          hwTime: Math.round(Number(cols[3])),
          dataHex: cols[4].toUpperCase(),
          acquisitionGen: parseInt(cols[5], 10)
        });
      }
      const count = insertFrames(frames);
      send(res, 200, { ok: true, count });
      return true;
    }

    if (path === '/api/timeline' && req.method === 'GET') {
      send(res, 200, frameTimeline());
      return true;
    }

    if (path === '/api/frame' && req.method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      const frames = listFrames();
      const frame = frames.find((f) => f.id === id);
      if (!frame) return send(res, 404, { error: 'frame-not-found' }), true;
      const ctx = buildContext();
      send(res, 200, replayOne(frame, ctx));
      return true;
    }

    if (path === '/api/signal-series' && req.method === 'GET') {
      const messageName = url.searchParams.get('message');
      const signalName = url.searchParams.get('signal');
      const series = replayAll()
        .filter(
          (d) =>
            d.message?.name === messageName &&
            d.signals.some((s) => s.signalName === signalName && !s.muxUnknown && s.physical !== null)
        )
        .map((d) => {
          const s = d.signals.find((x) => x.signalName === signalName)!;
          return { frameId: d.frame.id, hwTime: d.frame.hwTime, raw: s.raw, physical: s.physical, enumValue: s.enumValue };
        });
      send(res, 200, series);
      return true;
    }

    if (path === '/api/counters' && req.method === 'GET') {
      send(res, 200, counterReports());
      return true;
    }

    if (path === '/api/counters' && req.method === 'POST') {
      const body = await readBody(req);
      upsertCounterRule(body);
      send(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/crc' && req.method === 'GET') {
      send(res, 200, crcReports());
      return true;
    }

    if (path === '/api/crc' && req.method === 'POST') {
      const body = await readBody(req);
      upsertCrcRule(body);
      send(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/dbc' && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = parseDbc(body.text ?? '');
      const v = insertDbc({
        label: body.label,
        effectiveFrom: body.effectiveFrom ?? null,
        effectiveTo: body.effectiveTo ?? null,
        notes: body.notes ?? null
      });
      insertParsedDbc(v.id, parsed.messages);
      send(res, 200, { ok: true, id: v.id, parseErrors: parsed.errors });
      return true;
    }

    if (path === '/api/dbc-messages' && req.method === 'GET') {
      const dbcId = Number(url.searchParams.get('dbcId'));
      send(res, 200, getMessages(dbcId));
      return true;
    }

    if (path === '/api/compare' && req.method === 'GET') {
      const fromId = Number(url.searchParams.get('from'));
      const toId = Number(url.searchParams.get('to'));
      const fromMsgs = getMessages(fromId);
      const toMsgs = getMessages(toId);
      const keys = new Set(
        [...fromMsgs, ...toMsgs].map((m) => `${m.canId}:${m.isExtended ? 1 : 0}`)
      );
      const diffs = [...keys].sort().map((k) => {
        const [canIdStr, extStr] = k.split(':');
        const canId = Number(canIdStr);
        const isExtended = extStr === '1';
        const fm = fromMsgs.find((m) => m.canId === canId && m.isExtended === isExtended);
        const tm = toMsgs.find((m) => m.canId === canId && m.isExtended === isExtended);
        const diff = diffMessages(fm, tm, canId, isExtended);
        upsertMigration({
          fromDbcId: fromId,
          toDbcId: toId,
          canId,
          isExtended,
          fromMessage: diff.fromMessage,
          toMessage: diff.toMessage
        });
        return { ...diff, migration: listMigrations(fromId, toId).find((x) => x.canId === canId && x.isExtended === isExtended) };
      });
      send(res, 200, diffs);
      return true;
    }

    if (path === '/api/migration' && req.method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      send(res, 200, listMigrations(from ? Number(from) : undefined, to ? Number(to) : undefined));
      return true;
    }

    if (path === '/api/migration-approve' && req.method === 'POST') {
      const body = await readBody(req);
      const result = updateMigrationStatus(body.id, body.status, body.lockVersion, body.note ?? null);
      if (!result.ok) {
        send(res, 409, { ok: false, error: 'version-conflict', currentLock: result.currentLock });
      } else {
        send(res, 200, { ok: true, lockVersion: result.currentLock });
      }
      return true;
    }

    if (path === '/api/replay-with' && req.method === 'GET') {
      // 用指定 DBC 强制重放全部帧，并标注该定义相对当前生效区间是否已过期
      const forcedDbcId = Number(url.searchParams.get('dbcId'));
      const ctx = buildContext();
      const all = listDbcs();
      const rows = frozenReplay(listFrames(), forcedDbcId, ctx).map((d) => ({
        id: d.frame.id,
        hwTime: d.frame.hwTime,
        canId: d.frame.canId,
        isExtended: d.frame.isExtended,
        usedDbc: d.dbc?.label ?? null,
        currentDbcId: effectiveAt(all, d.frame.hwTime),
        stale: d.dbc ? effectiveAt(all, d.frame.hwTime) !== d.dbc.id : false,
        messageName: d.message?.name ?? null,
        reason: d.reason
      }));
      send(res, 200, rows);
      return true;
    }

    if (path === '/api/snapshot' && req.method === 'POST') {
      // 冻结调查快照：按指定（或当时生效）DBC 解码全部帧并固化
      const body = await readBody(req);
      const ctx = buildContext();
      const frozen = body.dbcId ?? null;
      const decoded = frozen === null
        ? listFrames().map((f) => replayOne(f, ctx))
        : frozenReplay(listFrames(), frozen, ctx);
      const id = saveSnapshot(body.label ?? `snapshot-${Date.now()}`, frozen, {
        frames: decoded,
        dbc: frozen ? getDbc(frozen) : null
      });
      send(res, 200, { ok: true, id });
      return true;
    }

    if (path === '/api/snapshot' && req.method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      send(res, 200, getSnapshot(id));
      return true;
    }

    send(res, 404, { error: 'unknown-api-route', path });
    return true;
  } catch (e: any) {
    send(res, 500, { error: 'server-error', message: String(e?.message ?? e) });
    return true;
  }
}
