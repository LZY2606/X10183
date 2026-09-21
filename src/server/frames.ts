// 总线刻度 — trace 导入：保存原始帧、通道、硬件时间、采集代次
import type Database from 'better-sqlite3';
import { rowToFrame, type FrameRow } from './repo.js';
import type { IdKind, RawFrame } from '../shared/types.js';
import { FRAME_ORDER_CLAUSE } from './db.js';

export interface ImportFrameInput {
  channel?: number;
  arbId: number;
  idKind?: IdKind;
  /** base64 / 十六进制字符串 / 字节数组 */
  data?: string | number[];
  dlc?: number;
  hwTimeNs: number;
}

export interface ImportResult {
  generation: number;
  label: string;
  imported: number;
}

function parseBytes(data: string | number[] | undefined, dlc: number): Uint8Array {
  if (Array.isArray(data)) {
    const bytes = Uint8Array.from(data);
    return pad(bytes, dlc);
  }
  if (typeof data === 'string') {
    const clean = data.trim().replace(/^0x/i, '').replace(/[\s_-]/g, '');
    if (clean === '') return new Uint8Array(dlc);
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      // 尝试 base64
      const b = Uint8Array.from(Buffer.from(data, 'base64'));
      if (b.length > 0) return pad(b, dlc);
      throw new Error(`无法解析帧数据: ${data.slice(0, 32)}`);
    }
    const hex = clean.length % 2 ? `0${clean}` : clean;
    const bytes = Uint8Array.from(
      (hex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))
    );
    return pad(bytes, dlc);
  }
  return new Uint8Array(dlc);
}

function pad(bytes: Uint8Array, dlc: number): Uint8Array {
  if (bytes.length > 8) throw new Error(`CAN 帧最多 8 字节，收到 ${bytes.length}`);
  if (dlc < bytes.length) throw new Error(`DLC=${dlc} 小于数据长度 ${bytes.length}`);
  const out = new Uint8Array(dlc);
  out.set(bytes);
  return out;
}

/**
 * 导入一批帧。重复时间戳原样保留；
 * 结果排序使用确定性次序，因此不同导入顺序产生相同分析结果。
 */
export function importFrames(
  db: Database.Database,
  inputs: ImportFrameInput[],
  label?: string
): ImportResult {
  if (!inputs.length) throw new Error('没有可导入的帧');

  return db.transaction(() => {
    const createdAt = new Date().toISOString();
    const genInfo = db
      .prepare('INSERT INTO generations (label, imported_at, frame_count) VALUES (?, ?, 0)')
      .run(label ?? `采集代次 ${createdAt}`, createdAt);
    const generation = Number(genInfo.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO frames (channel, arb_id, id_kind, data, dlc, hw_time_ns, generation, rx_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    inputs.forEach((f, idx) => {
      if (!Number.isInteger(f.arbId) || f.arbId < 0) {
        throw new Error(`第 ${idx + 1} 帧 arbitration id 非法`);
      }
      const idKind: IdKind = f.idKind ?? (f.arbId > 0x7ff ? 'ext' : 'std');
      if (idKind === 'std' && f.arbId > 0x7ff) {
        throw new Error(`标准帧 id ${f.arbId} 超出 11bit 范围`);
      }
      if (idKind === 'ext' && f.arbId > 0x1fffffff) {
        throw new Error(`扩展帧 id ${f.arbId} 超出 29bit 范围`);
      }
      if (!Number.isFinite(f.hwTimeNs)) {
        throw new Error(`第 ${idx + 1} 帧硬件时间非法`);
      }
      const dlc = f.dlc ?? (Array.isArray(f.data) ? f.data.length : inferDlc(f.data));
      if (dlc < 0 || dlc > 8) throw new Error(`第 ${idx + 1} 帧 DLC 非法`);
      const bytes = parseBytes(f.data, dlc);
      ins.run(
        f.channel ?? 0,
        f.arbId,
        idKind,
        Buffer.from(bytes),
        dlc,
        Math.round(f.hwTimeNs),
        generation,
        idx
      );
    });
    db.prepare('UPDATE generations SET frame_count = ? WHERE id = ?')
      .run(inputs.length, generation);
    return {
      generation,
      label: label ?? `采集代次 ${createdAt}`,
      imported: inputs.length
    };
  })();
}

function inferDlc(data: string | undefined): number {
  if (typeof data !== 'string') return 8;
  const clean = data.trim().replace(/^0x/i, '').replace(/[\s_-]/g, '');
  if (!clean || !/^[0-9a-fA-F]+$/.test(clean)) return 8;
  const hex = clean.length % 2 ? `0${clean}` : clean;
  return Math.min(8, hex.length / 2);
}

export interface FrameQuery {
  generation?: number;
  arbId?: number;
  idKind?: IdKind;
  channel?: number;
  limit?: number;
}

export function queryFrames(db: Database.Database, q: FrameQuery = {}): RawFrame[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.generation !== undefined) {
    where.push('f.generation = ?');
    params.push(q.generation);
  }
  if (q.arbId !== undefined) {
    where.push('f.arb_id = ?');
    params.push(q.arbId);
  }
  if (q.idKind) {
    where.push('f.id_kind = ?');
    params.push(q.idKind);
  }
  if (q.channel !== undefined) {
    where.push('f.channel = ?');
    params.push(q.channel);
  }
  const sql = `SELECT f.* FROM frames f ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ${FRAME_ORDER_CLAUSE} ${q.limit ? 'LIMIT ?' : ''}`;
  if (q.limit) params.push(q.limit);
  const rows = db.prepare(sql).all(...params) as FrameRow[];
  return rows.map(rowToFrame);
}

export function listGenerations(db: Database.Database) {
  return db
    .prepare('SELECT * FROM generations ORDER BY id')
    .all() as Record<string, unknown>[];
}
