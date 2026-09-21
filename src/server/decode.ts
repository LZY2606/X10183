// 总线刻度 — 按采集时点重放：为每帧选择生效版本并解码
import type Database from 'better-sqlite3';
import { decodeMessage } from '../shared/codec.js';
import type {
  DbcVersion, FrameDecode, MessageDef, RawFrame, StaleReason
} from '../shared/types.js';
import { FRAME_ORDER_CLAUSE } from './db.js';
import { rowToFrame, loadDecodeWithSignals, type FrameRow } from './repo.js';
import { getAllMessagesByVersion } from './repo.js';
import { listVersions, markStaleForDefinitions, pickAt } from './versions.js';

export interface DecodeStats {
  decoded: number;
  unmatched: number;
  stale: number;
  totalFrames: number;
}

interface LiveIndex {
  versions: DbcVersion[];
  messagesByVersion: Map<number, MessageDef[]>;
}

function buildIndex(db: Database.Database): LiveIndex {
  return {
    versions: listVersions(db),
    messagesByVersion: getAllMessagesByVersion(db)
  };
}

function findMessage(
  index: LiveIndex,
  frame: Pick<RawFrame, 'arbId' | 'idKind' | 'hwTimeNs'>
): { version: DbcVersion; message: MessageDef } | null {
  const version = pickAt(index.versions, frame.hwTimeNs);
  if (!version) return null;
  const message = (index.messagesByVersion.get(version.id) ?? []).find(
    (m) => m.arbId === frame.arbId && m.idKind === frame.idKind
  );
  return message ? { version, message } : null;
}

/**
 * 全量重放：按硬件时间为每帧选择生效定义并解码，落库。
 * 幂等；保留既有的过期标记，再统一重算。
 */
export function redecodeAll(db: Database.Database): DecodeStats {
  return db.transaction(() => {
    const index = buildIndex(db);
    const frames = db.prepare(`SELECT * FROM frames f ${FRAME_ORDER_CLAUSE}`).all() as FrameRow[];

    db.prepare('DELETE FROM decode_signals').run();
    db.prepare('DELETE FROM decodes').run();

    const insDecode = db.prepare(
      `INSERT INTO decodes (frame_id, version_id, message_name, arb_id, id_kind, stale_reason, decoded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insSig = db.prepare(
      `INSERT INTO decode_signals
        (decode_id, name, start_bit, length, byte_order, signed, factor, offset, unit, role,
         mux_type, mux_value, bit_cells_json, raw_value, phys_value, enum_label,
         mux_skipped, overrun, ord)
       VALUES
        (@decode_id, @name, @start_bit, @length, @byte_order, @signed, @factor, @offset, @unit, @role,
         @mux_type, @mux_value, @bit_cells_json, @raw_value, @phys_value, @enum_label,
         @mux_skipped, @overrun, @ord)`
    );

    let decoded = 0;
    let unmatched = 0;
    const now = new Date().toISOString();

    for (const row of frames) {
      const frame = rowToFrame(row);
      const hit = findMessage(index, frame);
      if (!hit) {
        unmatched += 1;
        continue;
      }
      const sigs = decodeMessage(hit.message, frame.data);
      const info = insDecode.run(
        frame.id,
        hit.version.id,
        hit.message.name,
        frame.arbId,
        frame.idKind,
        null,
        now
      );
      const decodeId = Number(info.lastInsertRowid);
      sigs.forEach((sig, ord) => {
        insSig.run({
          decode_id: decodeId,
          name: sig.signalName,
          start_bit: sig.startBit,
          length: sig.length,
          byte_order: sig.byteOrder,
          signed: sig.signed ? 1 : 0,
          factor: sig.factor,
          offset: sig.offset,
          unit: sig.unit,
          role: sig.role,
          mux_type: sig.muxType ?? null,
          mux_value: sig.muxValue ?? null,
          bit_cells_json: JSON.stringify(sig.bitCells),
          raw_value: sig.rawValue,
          phys_value: sig.physValue,
          enum_label: sig.enumLabel,
          mux_skipped: sig.muxSkipped ? 1 : 0,
          overrun: sig.overrun ? 1 : 0,
          ord
        });
      });
      decoded += 1;
    }

    markStaleForDefinitions(db, null);
    const stale = (
      db.prepare('SELECT COUNT(*) c FROM decodes WHERE stale_reason IS NOT NULL').get() as {
        c: number;
      }
    ).c;
    return { decoded, unmatched, stale, totalFrames: frames.length };
  })();
}

export interface UnmatchedFrame {
  frame: RawFrame;
  reason: string;
}

/** 没有任何生效定义 / 生效版本里没有该消息的帧 */
export function unmatchedFrames(db: Database.Database): UnmatchedFrame[] {
  const index = buildIndex(db);
  const frames = db
    .prepare(`SELECT f.* FROM frames f
              WHERE NOT EXISTS (SELECT 1 FROM decodes d WHERE d.frame_id = f.id)
              ${FRAME_ORDER_CLAUSE}`)
    .all() as FrameRow[];
  return frames.map((row) => {
    const frame = rowToFrame(row);
    const version = pickAt(index.versions, frame.hwTimeNs);
    const reason = !version
      ? '该硬件时间没有生效的 DBC 版本'
      : `版本「${version.label}」中没有 ${frame.idKind === 'ext' ? '扩展' : '标准'} id 0x${frame.arbId.toString(16)} 的消息定义`;
    return { frame, reason };
  });
}

export interface DecodeQuery {
  generation?: number;
  arbId?: number;
  idKind?: 'std' | 'ext';
  staleOnly?: boolean;
  limit?: number;
}

export function queryDecodes(db: Database.Database, q: DecodeQuery = {}): FrameDecode[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.generation !== undefined) {
    where.push('f.generation = ?');
    params.push(q.generation);
  }
  if (q.arbId !== undefined) {
    where.push('d.arb_id = ?');
    params.push(q.arbId);
  }
  if (q.idKind) {
    where.push('d.id_kind = ?');
    params.push(q.idKind);
  }
  if (q.staleOnly) where.push('d.stale_reason IS NOT NULL');
  const sql = `
    SELECT d.* FROM decodes d JOIN frames f ON f.id = d.frame_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.generation, f.hw_time_ns, f.channel, f.arb_id, f.id_kind, hex(f.data), f.id
    ${q.limit ? 'LIMIT ?' : ''}`;
  if (q.limit) params.push(q.limit);
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => loadDecodeWithSignals(db, r));
}

export function getDecodeForFrame(db: Database.Database, frameId: number): FrameDecode | null {
  const row = db.prepare('SELECT * FROM decodes WHERE frame_id = ?').get(frameId) as
    | Record<string, unknown>
    | undefined;
  return row ? loadDecodeWithSignals(db, row) : null;
}

/** 信号曲线：信号在确定性帧序上的时间序列（mux 未知分支返回 null 点） */
export interface SignalPoint {
  frameId: number;
  hwTimeNs: number;
  generation: number;
  raw: number | null;
  phys: number | null;
  muxSkipped: boolean;
  enumLabel: string | null;
}

export function signalSeries(
  db: Database.Database,
  arbId: number,
  idKind: 'std' | 'ext',
  signalName: string,
  generation?: number
): SignalPoint[] {
  const decodes = queryDecodes(db, { arbId, idKind, generation });
  const points: SignalPoint[] = [];
  for (const d of decodes) {
    const sig = d.signals.find((s) => s.signalName === signalName);
    if (!sig) continue;
    points.push({
      frameId: d.frameId,
      hwTimeNs: d.hwTimeNs,
      generation: d.generation,
      raw: sig.rawValue,
      phys: sig.physValue,
      muxSkipped: sig.muxSkipped,
      enumLabel: sig.enumLabel
    });
  }
  return points;
}

/** 过期原因中文说明 */
export function staleText(reason: StaleReason): string {
  switch (reason) {
    case 'message-removed':
      return '消息定义已从当前生效版本移除';
    case 'moved':
      return '该时间点现由其他 DBC 版本生效';
    case 'changed':
      return '信号定义已修订（布局/缩放/枚举等）';
    default:
      return '';
  }
}
