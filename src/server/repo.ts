// 总线刻度 — 行/对象映射
import type Database from 'better-sqlite3';
import type {
  CrcConfig, DbcVersion, DecodedSignal, FrameDecode, MessageDef,
  MuxType, RawFrame, SignalDef, ValTableEntry
} from '../shared/types.js';

export interface FrameRow {
  id: number;
  channel: number;
  arb_id: number;
  id_kind: 'std' | 'ext';
  data: Buffer;
  dlc: number;
  hw_time_ns: number;
  generation: number;
  rx_order: number;
}

export function rowToFrame(row: FrameRow): RawFrame {
  return {
    id: row.id,
    channel: row.channel,
    arbId: row.arb_id,
    idKind: row.id_kind,
    data: new Uint8Array(row.data),
    dlc: row.dlc,
    hwTimeNs: row.hw_time_ns,
    generation: row.generation,
    rxOrder: row.rx_order
  };
}

export function rowToVersion(row: Record<string, unknown>): DbcVersion {
  return {
    id: row.id as number,
    label: row.label as string,
    revision: row.revision as number,
    effectiveFromNs: (row.effective_from_ns as number | null) ?? null,
    effectiveToNs: (row.effective_to_ns as number | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdAt: row.created_at as string
  };
}

export function getMessages(
  db: Database.Database,
  versionId: number
): MessageDef[] {
  const msgRows = db
    .prepare('SELECT * FROM messages WHERE version_id = ? ORDER BY id')
    .all(versionId) as Record<string, unknown>[];
  const sigStmt = db.prepare('SELECT * FROM signals WHERE message_id = ? ORDER BY ord, id');
  return msgRows.map((mr) => ({
    versionId,
    id: mr.id as number,
    arbId: mr.arb_id as number,
    idKind: mr.id_kind as 'std' | 'ext',
    name: mr.name as string,
    length: mr.length as number,
    sender: (mr.sender as string) ?? '',
    signals: (sigStmt.all(mr.id) as Record<string, unknown>[]).map(rowToSignal)
  }));
}

export function getAllMessagesByVersion(db: Database.Database): Map<number, MessageDef[]> {
  const rows = db
    .prepare('SELECT * FROM messages ORDER BY version_id, id')
    .all() as Record<string, unknown>[];
  const sigRows = db.prepare('SELECT * FROM signals ORDER BY message_id, ord, id')
    .all() as Record<string, unknown>[];
  const sigsByMsg = new Map<number, SignalDef[]>();
  for (const sr of sigRows) {
    const list = sigsByMsg.get(sr.message_id as number) ?? [];
    list.push(rowToSignal(sr));
    sigsByMsg.set(sr.message_id as number, list);
  }
  const map = new Map<number, MessageDef[]>();
  for (const mr of rows) {
    const list = map.get(mr.version_id as number) ?? [];
    list.push({
      versionId: mr.version_id as number,
      id: mr.id as number,
      arbId: mr.arb_id as number,
      idKind: mr.id_kind as 'std' | 'ext',
      name: mr.name as string,
      length: mr.length as number,
      sender: (mr.sender as string) ?? '',
      signals: sigsByMsg.get(mr.id as number) ?? []
    });
    map.set(mr.version_id as number, list);
  }
  return map;
}

export function rowToSignal(row: Record<string, unknown>): SignalDef {
  return {
    id: row.id as number,
    versionId: row.version_id as number,
    messageId: row.message_id as number,
    name: row.name as string,
    startBit: row.start_bit as number,
    length: row.length as number,
    byteOrder: row.byte_order as 0 | 1,
    signed: Boolean(row.signed),
    factor: row.factor as number,
    offset: row.offset as number,
    unit: (row.unit as string) ?? '',
    min: (row.min_value as number | null) ?? null,
    max: (row.max_value as number | null) ?? null,
    muxType: (row.mux_type as MuxType | null) ?? null,
    muxValue: (row.mux_value as number | null) ?? null,
    role: (row.role as SignalDef['role']) ?? null,
    crc: (row.crc_json ? JSON.parse(row.crc_json as string) : null) as CrcConfig | null,
    counterModulus: (row.counter_modulus as number | null) ?? null,
    valTable: JSON.parse((row.val_table_json as string) ?? '[]') as ValTableEntry[]
  };
}

export function loadDecodedSignal(row: Record<string, unknown>): DecodedSignal {
  return {
    frameDecodeId: row.decode_id as number,
    signalName: row.name as string,
    startBit: row.start_bit as number,
    length: row.length as number,
    byteOrder: row.byte_order as 0 | 1,
    signed: Boolean(row.signed),
    factor: row.factor as number,
    offset: row.offset as number,
    unit: row.unit as string,
    role: (row.role as DecodedSignal['role']) ?? null,
    muxType: row.mux_type as MuxType,
    muxValue: (row.mux_value as number | null) ?? null,
    bitCells: JSON.parse(row.bit_cells_json as string),
    rawValue: (row.raw_value as number | null) ?? null,
    physValue: (row.phys_value as number | null) ?? null,
    enumLabel: (row.enum_label as string | null) ?? null,
    muxSkipped: Boolean(row.mux_skipped),
    overrun: Boolean(row.overrun)
  };
}

export function loadDecodeWithSignals(
  db: Database.Database,
  decodeRow: Record<string, unknown>
): FrameDecode {
  const frameId = decodeRow.frame_id as number;
  const frame = db.prepare('SELECT * FROM frames WHERE id = ?').get(frameId) as FrameRow;
  const sigRows = db
    .prepare('SELECT * FROM decode_signals WHERE decode_id = ? ORDER BY ord, id')
    .all(decodeRow.id) as Record<string, unknown>[];
  return {
    id: decodeRow.id as number,
    frameId,
    versionId: decodeRow.version_id as number,
    messageName: decodeRow.message_name as string,
    arbId: decodeRow.arb_id as number,
    idKind: decodeRow.id_kind as 'std' | 'ext',
    channel: frame.channel,
    hwTimeNs: frame.hw_time_ns,
    generation: frame.generation,
    dlc: frame.dlc,
    dataB64: Buffer.from(frame.data).toString('base64'),
    staleReason: (decodeRow.stale_reason as FrameDecode['staleReason']) ?? null,
    signals: sigRows.map(loadDecodedSignal)
  };
}
