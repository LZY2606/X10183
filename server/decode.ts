import type { DB } from './db.js';
import type {
  DecodedFrame,
  DecodedSignal,
  DbcVersion,
  Frame,
  MessageDef,
  SignalDef
} from '../src/types.js';
import { findMessage, getFrame, loadDbcVersion, resolveDbcsAt } from './repo.js';
import { extractRaw, rawBitsString, signalCells, toSigned } from './bitops.js';

function decodeSignal(
  frame: Frame,
  sig: SignalDef,
  active: boolean,
  reason: string | undefined
): DecodedSignal {
  const cells = signalCells(sig.byteOrder, sig.startBit, sig.length);
  const bits = rawBitsString(frame.data, cells);
  let raw: number | null = null;
  let physical: number | null = null;
  let enumLabel: string | null = null;

  if (active) {
    raw = extractRaw(frame.data, cells);
    const numeric = sig.signed ? toSigned(raw, sig.length) : raw;
    physical = Number((numeric * sig.scale + sig.offset).toFixed(9));
    const hit = sig.enums.find((e) => e.raw === numeric);
    if (hit) enumLabel = hit.label;
  }

  return {
    signalDefId: sig.id,
    name: sig.name,
    startBit: sig.startBit,
    length: sig.length,
    byteOrder: sig.byteOrder,
    signed: sig.signed,
    scale: sig.scale,
    offset: sig.offset,
    unit: sig.unit,
    muxType: sig.muxType,
    muxSwitch: sig.muxSwitch,
    active,
    reason,
    raw,
    rawBits: bits,
    bitCells: cells,
    physical,
    enumLabel
  };
}

export function decodeWithMessage(frame: Frame, dbc: DbcVersion | null, message: MessageDef | null, undecodedReason?: string): DecodedFrame {
  let signals: DecodedSignal[] = [];

  if (message) {
    const switcher = message.signals.find((s) => s.muxType === 'multiplexor');
    let switchRaw: number | null = null;
    if (switcher) {
      switchRaw = extractRaw(frame.data, signalCells(switcher.byteOrder, switcher.startBit, switcher.length));
    }
    signals = message.signals.map((sig) => {
      if (sig.muxType === 'multiplexor') return decodeSignal(frame, sig, true, undefined);
      if (sig.muxType === 'multiplexed') {
        if (switchRaw === null || !switcher) return decodeSignal(frame, sig, false, 'unknown-mux');
        const knownBranches = new Set(message.signals.filter((x) => x.muxType === 'multiplexed').map((x) => x.muxSwitch));
        if (!knownBranches.has(switchRaw)) return decodeSignal(frame, sig, false, 'unknown-mux');
        if (sig.muxSwitch !== switchRaw) return decodeSignal(frame, sig, false, 'inactive-branch');
        return decodeSignal(frame, sig, true, undefined);
      }
      return decodeSignal(frame, sig, true, undefined);
    });
  }

  const orders = new Set(signals.filter((s) => s.active).map((s) => s.byteOrder));
  const byteOrder = orders.size > 1 ? 'mixed' : ([...orders][0] ?? 'mixed');

  return {
    frame,
    dbcId: dbc?.id ?? null,
    dbcLabel: dbc?.label ?? null,
    messageDefId: message?.id ?? null,
    messageName: message?.name ?? null,
    byteOrder,
    signals,
    undecoded: !message,
    undecodedReason: message ? undefined : undecodedReason
  };
}

export function decodeFrameWithDbc(frame: Frame, dbc: DbcVersion | null): DecodedFrame {
  if (!dbc) return decodeWithMessage(frame, null, null, 'no-effective-dbc');
  const message = findMessage(dbc, frame.arbId, frame.extended);
  if (!message) return decodeWithMessage(frame, dbc, null, 'no-message-in-dbc');
  return decodeWithMessage(frame, dbc, message);
}

// 按帧时点解析生效 DBC；标准/扩展 ID 严格分开
export function decodeFrameAtTime(frame: Frame, db: DB): DecodedFrame {
  const dbcs = resolveDbcsAt(db, frame.hwTime);
  for (const dbc of dbcs) {
    const message = findMessage(dbc, frame.arbId, frame.extended);
    if (message) return decodeWithMessage(frame, dbc, message);
  }
  return decodeWithMessage(frame, dbcs[0] ?? null, null, dbcs.length ? 'no-message-in-dbc' : 'no-effective-dbc');
}

const cacheGet = (db: DB, frameId: number) =>
  db.prepare('SELECT dbc_id, json, stale FROM decode_cache WHERE frame_id = ?').get(frameId) as
    | { dbc_id: number | null; json: string; stale: number }
    | undefined;

export function decodeFrame(db: DB, frameId: number): DecodedFrame {
  const frame = getFrame(db, frameId);
  if (!frame) throw new Error('帧不存在');
  const fresh = decodeFrameAtTime(frame, db);
  const cached = cacheGet(db, frameId);
  if (cached && cached.stale === 0 && cached.dbc_id === fresh.dbcId) {
    return JSON.parse(cached.json) as DecodedFrame;
  }
  db.prepare(
    `INSERT INTO decode_cache (frame_id, dbc_id, message_def_id, json, stale)
     VALUES (@frameId, @dbcId, @msgId, @json, 0)
     ON CONFLICT(frame_id) DO UPDATE SET
       dbc_id = excluded.dbc_id,
       message_def_id = excluded.message_def_id,
       json = excluded.json,
       stale = 0`
  ).run({
    frameId,
    dbcId: fresh.dbcId,
    msgId: fresh.messageDefId,
    json: JSON.stringify(replaceFrame(fresh, frame))
  });
  return fresh;
}

function replaceFrame(decoded: DecodedFrame, frame: Frame): DecodedFrame {
  return { ...decoded, frame };
}

export function decodeTimeline(db: DB, opts: { limit?: number; offset?: number } = {}): DecodedFrame[] {
  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT f.id FROM frames f
       ORDER BY f.hw_time, f.channel, f.arb_id, f.extended, f.data_hex, f.id
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as { id: number }[];
  return rows.map((r) => decodeFrame(db, r.id));
}

export function decodeWithVersion(db: DB, dbcId: number, frameIds?: number[]): DecodedFrame[] {
  const dbc = resolveDbcVersionOrThrow(db, dbcId);
  const rows = frameIds
    ? frameIds.map((id) => ({ id }))
    : (db
        .prepare('SELECT id FROM frames ORDER BY hw_time, channel, arb_id, extended, data_hex, id')
        .all() as { id: number }[]);
  return rows
    .map((r) => getFrame(db, r.id))
    .filter((f): f is Frame => !!f)
    .map((f) => {
      const decoded = decodeFrameWithDbc(f, dbc);
      return decoded;
    });
}

function resolveDbcVersionOrThrow(db: DB, dbcId: number): DbcVersion {
  const dbc = loadDbcVersion(db, dbcId);
  if (!dbc) throw new Error('DBC 版本不存在');
  return dbc;
}

// 强制重算全部缓存（供测试与管理操作使用）
export function recomputeAll(db: DB): DecodedFrame[] {
  db.prepare('DELETE FROM decode_cache').run();
  return decodeTimeline(db, { limit: Number.MAX_SAFE_INTEGER });
}

export function staleCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM decode_cache WHERE stale = 1').get() as { c: number }).c;
}
