import type { DB } from './db.js';
import type { DbcVersion, Frame, MessageDef, SignalDef, ValueDesc } from '../src/types.js';

interface SignalRow {
  id: number;
  message_def_id: number;
  name: string;
  start_bit: number;
  length: number;
  byte_order: 'intel' | 'motorola';
  signed: number;
  scale: number;
  offset: number;
  unit: string;
  mux_type: 'none' | 'multiplexor' | 'multiplexed';
  mux_switch: number | null;
}

export function loadSignals(db: DB, messageDefId: number): SignalDef[] {
  const rows = db.prepare('SELECT * FROM signal_defs WHERE message_def_id = ? ORDER BY id').all(messageDefId) as SignalRow[];
  return rows.map((r) => ({
    id: r.id,
    messageDefId: r.message_def_id,
    name: r.name,
    startBit: r.start_bit,
    length: r.length,
    byteOrder: r.byte_order,
    signed: !!r.signed,
    scale: r.scale,
    offset: r.offset,
    unit: r.unit,
    muxType: r.mux_type,
    muxSwitch: r.mux_switch,
    enums: db
      .prepare('SELECT raw, label FROM value_descs WHERE signal_def_id = ? ORDER BY raw')
      .all(r.id) as ValueDesc[]
  }));
}

interface MsgRow {
  id: number;
  dbc_id: number;
  arb_id: number;
  extended: number;
  name: string;
  dlc: number;
  transmitter: string;
}

export function loadMessages(db: DB, dbcId: number): MessageDef[] {
  const rows = db.prepare('SELECT * FROM message_defs WHERE dbc_id = ? ORDER BY arb_id, extended').all(dbcId) as MsgRow[];
  return rows.map((r) => ({
    id: r.id,
    dbcId: r.dbc_id,
    arbId: r.arb_id,
    extended: !!r.extended,
    name: r.name,
    dlc: r.dlc,
    transmitter: r.transmitter,
    signals: loadSignals(db, r.id)
  }));
}

export function loadDbcVersion(db: DB, dbcId: number): DbcVersion | null {
  const row = db.prepare('SELECT * FROM dbc_versions WHERE id = ?').get(dbcId) as
    | { id: number; label: string; source: string; effective_from: number | null; effective_to: number | null; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    source: row.source,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    version: (row as { version?: number }).version ?? 1,
    messages: loadMessages(db, row.id)
  };
}

export function listDbcVersions(db: DB): DbcVersion[] {
  const ids = db.prepare('SELECT id FROM dbc_versions ORDER BY id').all() as { id: number }[];
  return ids.map((r) => loadDbcVersion(db, r.id)!).filter(Boolean);
}

// 生效区间 [from, to)，重叠时取最小 id（最早建立的定义）
export function resolveDbcAt(db: DB, hwTime: number): DbcVersion | null {
  const row = db
    .prepare(
      `SELECT id FROM dbc_versions
       WHERE (effective_from IS NULL OR effective_from <= ?)
         AND (effective_to IS NULL OR ? < effective_to)
       ORDER BY id ASC LIMIT 1`
    )
    .get(hwTime, hwTime) as { id: number } | undefined;
  return row ? loadDbcVersion(db, row.id) : null;
}

// 某时点全部生效版本（id 升序），允许跨版本查找消息定义
export function resolveDbcsAt(db: DB, hwTime: number): DbcVersion[] {
  const rows = db
    .prepare(
      `SELECT id FROM dbc_versions
       WHERE (effective_from IS NULL OR effective_from <= ?)
         AND (effective_to IS NULL OR ? < effective_to)
       ORDER BY id ASC`
    )
    .all(hwTime, hwTime) as { id: number }[];
  return rows.map((r) => loadDbcVersion(db, r.id)!).filter(Boolean);
}

export function findMessage(
  dbc: DbcVersion,
  arbId: number,
  extended: boolean
): MessageDef | null {
  return dbc.messages.find((m) => m.arbId === arbId && m.extended === extended) ?? null;
}

interface FrameRow {
  id: number;
  import_id: number;
  import_gen: number;
  channel: number;
  arb_id: number;
  extended: number;
  hw_time: number;
  data_hex: string;
}

import { hexToBytes } from './bitops.js';

export function rowToFrame(r: FrameRow, importedAt: string): Frame {
  return {
    id: r.id,
    importId: r.import_id,
    importGen: r.import_gen,
    channel: r.channel,
    arbId: r.arb_id,
    extended: !!r.extended,
    hwTime: r.hw_time,
    data: hexToBytes(r.data_hex),
    importedAt
  };
}

export function getFrame(db: DB, id: number): Frame | null {
  const row = db.prepare('SELECT * FROM frames WHERE id = ?').get(id) as FrameRow | undefined;
  if (!row) return null;
  const imp = db.prepare('SELECT imported_at FROM trace_imports WHERE id = ?').get(row.import_id) as
    | { imported_at: string }
    | undefined;
  return rowToFrame(row, imp?.imported_at ?? '');
}

// 确定性顺序：硬件时间 → 通道 → ID → 帧类型 → 数据 → 主键
export function listFramesOrdered(db: DB): Frame[] {
  const rows = db
    .prepare(
      `SELECT f.*, t.imported_at AS imported_at
       FROM frames f JOIN trace_imports t ON t.id = f.import_id
       ORDER BY f.hw_time, f.channel, f.arb_id, f.extended, f.data_hex, f.id`
    )
    .all() as (FrameRow & { imported_at: string })[];
  return rows.map((r) => rowToFrame(r, r.imported_at));
}
