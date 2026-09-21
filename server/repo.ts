
import { db } from './db.js';
import type {
  CrcCoverage,
  CrcRule,
  CounterRule,
  DbcVersion,
  MessageDef,
  MigrationMapping,
  MigrationStatus,
  RawFrame,
  SignalDef
} from '../src/core/types.js';

type Row = Record<string, unknown>;

function num(v: unknown): number {
  return Number(v);
}

export function mapDbc(r: Row): DbcVersion {
  return {
    id: num(r.id),
    label: String(r.label),
    effectiveFrom: r.effective_from === null ? null : num(r.effective_from),
    effectiveTo: r.effective_to === null ? null : num(r.effective_to),
    createdAt: num(r.created_at),
    notes: r.notes === null ? null : String(r.notes)
  };
}

export function mapSignal(r: Row): SignalDef {
  const muxRaw = String(r.mux_role);
  const mux: SignalDef['muxRole'] =
    muxRaw === 'normal' ? 'normal' : muxRaw === 'switch' ? 'switch' : num(muxRaw);
  return {
    id: num(r.id),
    messageId: num(r.message_id),
    name: String(r.name),
    startBit: num(r.start_bit),
    bitLength: num(r.bit_length),
    byteOrder: String(r.byte_order) as 'intel' | 'motorola',
    sign: String(r.sign) as '+' | '-',
    factor: num(r.factor),
    offset: num(r.offset),
    minimum: r.minimum === null ? null : num(r.minimum),
    maximum: r.maximum === null ? null : num(r.maximum),
    unit: r.unit === null ? null : String(r.unit),
    muxRole: mux,
    enumMap: JSON.parse(String(r.enum_map)) as Record<number, string>
  };
}

export function getMessages(dbcId: number): MessageDef[] {
  const d = db();
  const msgs = d
    .prepare('SELECT * FROM messages WHERE dbc_id = ? ORDER BY can_id')
    .all(dbcId) as Row[];
  return msgs.map((m) => {
    const sigs = d
      .prepare('SELECT * FROM signals WHERE message_id = ? ORDER BY start_bit')
      .all(num(m.id)) as Row[];
    return {
      id: num(m.id),
      dbcId,
      canId: num(m.can_id),
      isExtended: num(m.is_extended) === 1,
      name: String(m.name),
      dlc: num(m.dlc),
      transmitter: m.transmitter === null ? null : String(m.transmitter),
      signals: sigs.map(mapSignal)
    };
  });
}

export function listDbcs(): DbcVersion[] {
  return (db().prepare('SELECT * FROM dbc_versions ORDER BY id').all() as Row[]).map(mapDbc);
}

export function getDbc(id: number): DbcVersion | null {
  const r = db().prepare('SELECT * FROM dbc_versions WHERE id = ?').get(id) as Row | undefined;
  return r ? mapDbc(r) : null;
}

export function mapFrame(r: Row): RawFrame {
  return {
    id: num(r.id),
    canId: num(r.can_id),
    isExtended: num(r.is_extended) === 1,
    channel: num(r.channel),
    hwTime: num(r.hw_time),
    dataHex: String(r.data_hex),
    acquisitionGen: num(r.acquisition_gen),
    importSeq: num(r.import_seq)
  };
}

/** 稳定顺序：硬件时间优先，重复时间戳以帧 id（而非导入顺序）打破平局 */
export function listFrames(): RawFrame[] {
  return (
    db()
      .prepare('SELECT * FROM frames ORDER BY hw_time, acquisition_gen, channel, id')
      .all() as Row[]
  ).map(mapFrame);
}

export function maxImportSeq(): number {
  const r = db().prepare('SELECT COALESCE(MAX(import_seq), 0) AS m FROM frames').get() as Row;
  return num(r.m);
}

export function insertFrames(
  frames: {
    canId: number;
    isExtended: boolean;
    channel: number;
    hwTime: number;
    dataHex: string;
    acquisitionGen: number;
  }[]
): number {
  const d = db();
  const stmt = d.prepare(
    `INSERT INTO frames (can_id, is_extended, channel, hw_time, data_hex, acquisition_gen, import_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let seq = maxImportSeq();
  let count = 0;
  for (const f of frames) {
    seq += 1;
    stmt.run(
      f.canId,
      f.isExtended ? 1 : 0,
      f.channel,
      f.hwTime,
      f.dataHex,
      f.acquisitionGen,
      seq
    );
    count += 1;
  }
  return count;
}

export function clearFrames(): void {
  db().exec('DELETE FROM frames');
}

export function insertDbc(v: {
  label: string;
  effectiveFrom: number | null;
  effectiveTo: number | null;
  notes?: string | null;
  createdAt?: number;
}): DbcVersion {
  const d = db();
  const info = d
    .prepare(
      'INSERT INTO dbc_versions (label, effective_from, effective_to, created_at, notes) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      v.label,
      v.effectiveFrom,
      v.effectiveTo,
      v.createdAt ?? Date.now(),
      v.notes ?? null
    );
  return getDbc(num(info.lastInsertRowid))!;
}

export function insertParsedDbc(
  dbcId: number,
  messages: {
    canId: number;
    isExtended: boolean;
    name: string;
    dlc: number;
    transmitter: string | null;
    signals: {
      name: string;
      startBit: number;
      bitLength: number;
      byteOrder: 'intel' | 'motorola';
      sign: '+' | '-';
      factor: number;
      offset: number;
      minimum: number | null;
      maximum: number | null;
      unit: string | null;
      mux: 'normal' | 'switch' | number;
    }[];
    enumMap: Record<string, Record<number, string>>;
  }[]
): void {
  const d = db();
  const insMsg = d.prepare(
    'INSERT INTO messages (dbc_id, can_id, is_extended, name, dlc, transmitter) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insSig = d.prepare(
    `INSERT INTO signals (message_id, name, start_bit, bit_length, byte_order, sign, factor, offset,
      minimum, maximum, unit, mux_role, enum_map) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const m of messages) {
    const info = insMsg.run(dbcId, m.canId, m.isExtended ? 1 : 0, m.name, m.dlc, m.transmitter);
    const mid = num(info.lastInsertRowid);
    for (const s of m.signals) {
      insSig.run(
        mid,
        s.name,
        s.startBit,
        s.bitLength,
        s.byteOrder,
        s.sign,
        s.factor,
        s.offset,
        s.minimum,
        s.maximum,
        s.unit,
        String(s.mux),
        JSON.stringify(m.enumMap[s.name] ?? {})
      );
    }
  }
}

export function listCounterRules(): CounterRule[] {
  return (db().prepare('SELECT * FROM counter_rules ORDER BY id').all() as Row[]).map((r) => ({
    id: num(r.id),
    node: String(r.node),
    signalName: String(r.signal_name),
    maxValue: r.max_value === null ? null : num(r.max_value),
    dbcId: r.dbc_id === null ? null : num(r.dbc_id)
  }));
}

export function upsertCounterRule(r: {
  node: string;
  signalName: string;
  maxValue: number | null;
  dbcId: number | null;
}): void {
  db()
    .prepare(
      `INSERT INTO counter_rules (node, signal_name, max_value, dbc_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(node, signal_name) DO UPDATE SET max_value = excluded.max_value, dbc_id = excluded.dbc_id`
    )
    .run(r.node, r.signalName, r.maxValue, r.dbcId);
}

export function listCrcRules(): CrcRule[] {
  return (db().prepare('SELECT * FROM crc_rules ORDER BY id').all() as Row[]).map((r) => ({
    id: num(r.id),
    messageName: String(r.message_name),
    signalName: r.signal_name === null ? null : String(r.signal_name),
    coverage: JSON.parse(String(r.coverage)) as CrcCoverage[],
    init: r.init === null ? null : num(r.init),
    xorOut: r.xor_out === null ? null : num(r.xor_out),
    dbcId: r.dbc_id === null ? null : num(r.dbc_id)
  }));
}

export function upsertCrcRule(r: {
  messageName: string;
  signalName: string | null;
  coverage: CrcCoverage[];
  init: number | null;
  xorOut: number | null;
  dbcId: number | null;
}): void {
  db()
    .prepare(
      `INSERT INTO crc_rules (message_name, signal_name, coverage, init, xor_out, dbc_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_name) DO UPDATE SET
         signal_name = excluded.signal_name, coverage = excluded.coverage,
         init = excluded.init, xor_out = excluded.xor_out, dbc_id = excluded.dbc_id`
    )
    .run(r.messageName, r.signalName, JSON.stringify(r.coverage), r.init, r.xorOut, r.dbcId);
}

export function saveSnapshot(label: string, frozenDbcId: number | null, payload: unknown): number {
  const info = db()
    .prepare('INSERT INTO snapshots (label, created_at, frozen_dbc_id, payload) VALUES (?, ?, ?, ?)')
    .run(label, Date.now(), frozenDbcId, JSON.stringify(payload));
  return num(info.lastInsertRowid);
}

export function listSnapshots(): {
  id: number;
  label: string;
  createdAt: number;
  frozenDbcId: number | null;
}[] {
  return (db().prepare('SELECT id, label, created_at, frozen_dbc_id FROM snapshots ORDER BY id').all() as Row[]).map(
    (r) => ({
      id: num(r.id),
      label: String(r.label),
      createdAt: num(r.created_at),
      frozenDbcId: r.frozen_dbc_id === null ? null : num(r.frozen_dbc_id)
    })
  );
}

export function getSnapshot(id: number): unknown {
  const r = db().prepare('SELECT payload FROM snapshots WHERE id = ?').get(id) as Row | undefined;
  return r ? JSON.parse(String(r.payload)) : null;
}

export function listMigrations(from?: number, to?: number): MigrationMapping[] {
  let sql = 'SELECT * FROM migrations';
  const where: string[] = [];
  const params: (string | number | null)[] = [];
  if (from !== undefined) {
    where.push('from_dbc_id = ?');
    params.push(from);
  }
  if (to !== undefined) {
    where.push('to_dbc_id = ?');
    params.push(to);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id';
  return (db().prepare(sql).all(...params) as Row[]).map((r) => ({
    id: num(r.id),
    fromDbcId: num(r.from_dbc_id),
    toDbcId: num(r.to_dbc_id),
    canId: num(r.can_id),
    isExtended: num(r.is_extended) === 1,
    fromMessage: r.from_message === null ? null : String(r.from_message),
    toMessage: r.to_message === null ? null : String(r.to_message),
    status: String(r.status) as MigrationStatus,
    note: r.note === null ? null : String(r.note),
    lockVersion: num(r.lock_version)
  }));
}

export function upsertMigration(m: {
  fromDbcId: number;
  toDbcId: number;
  canId: number;
  isExtended: boolean;
  fromMessage: string | null;
  toMessage: string | null;
  status?: MigrationStatus;
  note?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO migrations (from_dbc_id, to_dbc_id, can_id, is_extended, from_message, to_message, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_dbc_id, to_dbc_id, can_id, is_extended) DO UPDATE SET
         from_message = excluded.from_message, to_message = excluded.to_message,
         status = excluded.status, note = excluded.note`
    )
    .run(
      m.fromDbcId,
      m.toDbcId,
      m.canId,
      m.isExtended ? 1 : 0,
      m.fromMessage,
      m.toMessage,
      m.status ?? 'pending',
      m.note ?? null
    );
}

/** 乐观并发：lock_version 不匹配则拒绝（并发审批基于版本号冲突） */
export function updateMigrationStatus(
  id: number,
  status: MigrationStatus,
  expectedLock: number,
  note?: string | null
): { ok: boolean; currentLock: number } {
  const d = db();
  const row = d.prepare('SELECT lock_version FROM migrations WHERE id = ?').get(id) as
    | Row
    | undefined;
  if (!row) throw new Error('migration-not-found');
  const currentLock = num(row.lock_version);
  if (currentLock !== expectedLock) return { ok: false, currentLock };
  d.prepare(
    'UPDATE migrations SET status = ?, lock_version = lock_version + 1, note = COALESCE(?, note) WHERE id = ?'
  ).run(status, note ?? null, id);
  return { ok: true, currentLock: currentLock + 1 };
}
