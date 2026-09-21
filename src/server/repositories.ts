import type { DatabaseSync } from 'node:sqlite';
import type { DbHandle } from './db.js';
import type { StoredFrame } from '../core/types.js';

export interface FrameRow {
  id: number;
  importId: number;
  generation: number;
  channel: number;
  arbitrationId: number;
  isExtended: boolean;
  direction: string;
  hwTime: number;
  dlc: number;
  data: number[];
  contentHash: string;
}

function toFrameRow(r: Record<string, unknown>): FrameRow {
  const buf = r.data as Buffer;
  return {
    id: Number(r.id),
    importId: Number(r.import_id),
    generation: Number(r.generation),
    channel: Number(r.channel),
    arbitrationId: Number(r.arbitration_id),
    isExtended: Number(r.is_extended) === 1,
    direction: String(r.direction),
    hwTime: Number(r.hw_time),
    dlc: Number(r.dlc),
    data: Array.from(buf.values()),
    contentHash: String(r.content_hash ?? ''),
  };
}

export function listFrames(handle: DbHandle, filter?: { id?: number; isExtended?: boolean; generation?: number }): FrameRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.id !== undefined) {
    where.push('arbitration_id = ?');
    params.push(filter.id);
  }
  if (filter?.isExtended !== undefined) {
    where.push('is_extended = ?');
    params.push(filter.isExtended ? 1 : 0);
  }
  if (filter?.generation !== undefined) {
    where.push('generation = ?');
    params.push(filter.generation);
  }
  const sql = `SELECT * FROM frames ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY hw_time, id`;
  return (handle.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map(toFrameRow);
}

export function getFrame(handle: DbHandle, frameId: number): FrameRow | undefined {
  const row = handle.db.prepare('SELECT * FROM frames WHERE id = ?').get(frameId) as Record<string, unknown> | undefined;
  return row ? toFrameRow(row) : undefined;
}

export function frameRowToStored(f: FrameRow): StoredFrame {
  return {
    frameId: f.id,
    generation: f.generation,
    channel: f.channel,
    id: f.arbitrationId,
    isExtended: f.isExtended,
    direction: f.direction,
    hwTime: f.hwTime,
    dlc: f.dlc,
    data: f.data,
  } as StoredFrame;
}

/* ----------------------------- interpretations ---------------------------- */

export function saveInterpretation(
  handle: DbHandle,
  frameId: number,
  dbcVersionId: number,
  messageRowId: number,
  definitionHash: string,
  payload: unknown
): void {
  handle.db
    .prepare(
      `INSERT INTO interpretations (frame_id, dbc_version_id, message_id, definition_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(frame_id, dbc_version_id) DO UPDATE SET
         message_id = excluded.message_id,
         definition_hash = excluded.definition_hash,
         payload_json = excluded.payload_json,
         created_at = excluded.created_at`
    )
    .run(frameId, dbcVersionId, messageRowId, definitionHash, JSON.stringify(payload), Date.now() / 1000);
}

export interface InterpretationRow {
  id: number;
  frameId: number;
  dbcVersionId: number;
  messageId: number;
  definitionHash: string;
  payload: unknown;
}

export function getInterpretation(
  handle: DbHandle,
  frameId: number,
  dbcVersionId: number
): InterpretationRow | undefined {
  const r = handle.db
    .prepare('SELECT * FROM interpretations WHERE frame_id = ? AND dbc_version_id = ?')
    .get(frameId, dbcVersionId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    id: Number(r.id),
    frameId: Number(r.frame_id),
    dbcVersionId: Number(r.dbc_version_id),
    messageId: Number(r.message_id),
    definitionHash: String(r.definition_hash),
    payload: JSON.parse(String(r.payload_json)),
  };
}

export function currentDefinitionHash(handle: DbHandle, dbcVersionId: number): string | undefined {
  const r = handle.db.prepare('SELECT definition_hash FROM dbc_versions WHERE id = ?').get(dbcVersionId) as
    | Record<string, unknown>
    | undefined;
  return r ? String(r.definition_hash) : undefined;
}

export function isInterpretationStale(handle: DbHandle, interp: InterpretationRow): boolean {
  return currentDefinitionHash(handle, interp.dbcVersionId) !== interp.definitionHash;
}

/* ------------------------------ counter cfg ------------------------------- */

export interface CounterCfgRow {
  id: number;
  messageKey: string;
  arbitrationId: number;
  isExtended: boolean;
  node: string;
  signalName: string;
  modulus: number;
  increment: number;
}

export function upsertCounterConfig(handle: DbHandle, cfg: Omit<CounterCfgRow, 'id'>): void {
  const db: DatabaseSync = handle.db;
  db.prepare(
    `INSERT INTO counter_configs (message_key, arbitration_id, is_extended, node, signal_name, modulus, increment)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_key) DO UPDATE SET
       node = excluded.node, signal_name = excluded.signal_name,
       modulus = excluded.modulus, increment = excluded.increment`
  ).run(cfg.messageKey, cfg.arbitrationId, cfg.isExtended ? 1 : 0, cfg.node, cfg.signalName, cfg.modulus, cfg.increment);
}

export function listCounterConfigs(handle: DbHandle): CounterCfgRow[] {
  return (handle.db.prepare('SELECT * FROM counter_configs ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    messageKey: String(r.message_key),
    arbitrationId: Number(r.arbitration_id),
    isExtended: Number(r.is_extended) === 1,
    node: String(r.node),
    signalName: String(r.signal_name),
    modulus: Number(r.modulus),
    increment: Number(r.increment),
  }));
}

/* -------------------------------- crc cfg --------------------------------- */

export interface CrcCfgRow {
  id: number;
  messageKey: string;
  arbitrationId: number;
  isExtended: boolean;
  width: number | null;
  poly: number | null;
  init: number | null;
  xorOut: number | null;
  reflectIn: boolean;
  reflectOut: boolean;
  coverageMode: string | null;
  coverageFirst: number | null;
  coverageLast: number | null;
  coveragePositions: number[];
  crcPositions: number[];
  signalName: string | null;
}

export function upsertCrcConfig(handle: DbHandle, cfg: Omit<CrcCfgRow, 'id'>): void {
  handle.db
    .prepare(
      `INSERT INTO crc_configs (message_key, arbitration_id, is_extended, width, poly, init_value, xor_out,
        reflect_in, reflect_out, coverage_mode, coverage_first, coverage_last, coverage_positions, crc_positions, signal_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_key) DO UPDATE SET
         width = excluded.width, poly = excluded.poly, init_value = excluded.init_value, xor_out = excluded.xor_out,
         reflect_in = excluded.reflect_in, reflect_out = excluded.reflect_out, coverage_mode = excluded.coverage_mode,
         coverage_first = excluded.coverage_first, coverage_last = excluded.coverage_last,
         coverage_positions = excluded.coverage_positions, crc_positions = excluded.crc_positions,
         signal_name = excluded.signal_name`
    )
    .run(
      cfg.messageKey,
      cfg.arbitrationId,
      cfg.isExtended ? 1 : 0,
      cfg.width,
      cfg.poly,
      cfg.init,
      cfg.xorOut,
      cfg.reflectIn ? 1 : 0,
      cfg.reflectOut ? 1 : 0,
      cfg.coverageMode,
      cfg.coverageFirst,
      cfg.coverageLast,
      JSON.stringify(cfg.coveragePositions),
      JSON.stringify(cfg.crcPositions),
      cfg.signalName
    );
}

export function listCrcConfigs(handle: DbHandle): CrcCfgRow[] {
  return (handle.db.prepare('SELECT * FROM crc_configs ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    messageKey: String(r.message_key),
    arbitrationId: Number(r.arbitration_id),
    isExtended: Number(r.is_extended) === 1,
    width: r.width === null ? null : Number(r.width),
    poly: r.poly === null ? null : Number(r.poly),
    init: r.init_value === null ? null : Number(r.init_value),
    xorOut: r.xor_out === null ? null : Number(r.xor_out),
    reflectIn: Number(r.reflect_in) === 1,
    reflectOut: Number(r.reflect_out) === 1,
    coverageMode: r.coverage_mode === null ? null : String(r.coverage_mode),
    coverageFirst: r.coverage_first === null ? null : Number(r.coverage_first),
    coverageLast: r.coverage_last === null ? null : Number(r.coverage_last),
    coveragePositions: JSON.parse(String(r.coverage_positions ?? '[]')),
    crcPositions: JSON.parse(String(r.crc_positions ?? '[]')),
    signalName: r.signal_name === null ? null : String(r.signal_name),
  }));
}

/* ------------------------------- snapshots -------------------------------- */

export function saveSnapshot(
  handle: DbHandle,
  title: string,
  note: string,
  frameId: number,
  dbcVersionId: number,
  frameJson: unknown,
  definitionJson: unknown,
  decodeJson: unknown
): number {
  const info = handle.db
    .prepare(
      `INSERT INTO snapshots (title, note, frame_id, dbc_version_id, frame_json, definition_json, decode_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      note,
      frameId,
      dbcVersionId,
      JSON.stringify(frameJson),
      JSON.stringify(definitionJson),
      JSON.stringify(decodeJson),
      Date.now() / 1000
    );
  return Number(info.lastInsertRowid);
}

export function listSnapshots(handle: DbHandle) {
  return (handle.db.prepare('SELECT * FROM snapshots ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    title: String(r.title),
    note: String(r.note),
    frameId: Number(r.frame_id),
    dbcVersionId: Number(r.dbc_version_id),
    createdAt: Number(r.created_at),
  }));
}

export function getSnapshot(handle: DbHandle, snapshotId: number) {
  const r = handle.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    id: Number(r.id),
    title: String(r.title),
    note: String(r.note),
    frameId: Number(r.frame_id),
    dbcVersionId: Number(r.dbc_version_id),
    createdAt: Number(r.created_at),
    frame: JSON.parse(String(r.frame_json)),
    definition: JSON.parse(String(r.definition_json)),
    decode: JSON.parse(String(r.decode_json)),
  };
}

/* ----------------------------- migration maps ----------------------------- */

export interface MigrationMapRow {
  id: number;
  fromVersion: number;
  toVersion: number;
  messageKey: string;
  payload: unknown;
  status: string;
  version: number;
  approvedBy: string | null;
  approvedAt: number | null;
}

export function putMigrationMap(
  handle: DbHandle,
  row: Omit<MigrationMapRow, 'id' | 'version' | 'approvedBy' | 'approvedAt'> & { expectedVersion?: number }
): { ok: true; version: number } | { ok: false; conflict: true; current: number } {
  const db: DatabaseSync = handle.db;
  const existing = db
    .prepare('SELECT id, version FROM migration_maps WHERE from_version = ? AND to_version = ? AND message_key = ?')
    .get(row.fromVersion, row.toVersion, row.messageKey) as { id: number; version: number } | undefined;

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO migration_maps (from_version, to_version, message_key, payload_json, status, version)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(row.fromVersion, row.toVersion, row.messageKey, JSON.stringify(row.payload), row.status);
    void info;
    return { ok: true, version: 1 };
  }

  if (row.expectedVersion !== undefined && existing.version !== row.expectedVersion) {
    return { ok: false, conflict: true, current: existing.version };
  }
  db.prepare(
    `UPDATE migration_maps SET payload_json = ?, status = ?, version = version + 1 WHERE id = ?`
  ).run(JSON.stringify(row.payload), row.status, existing.id);
  return { ok: true, version: existing.version + 1 };
}

export function approveMigrationMap(
  handle: DbHandle,
  fromVersion: number,
  toVersion: number,
  messageKey: string,
  approver: string,
  expectedVersion: number
): { ok: true; version: number } | { ok: false; conflict: true; current: number } | { ok: false; reason: string } {
  const existing = handle.db
    .prepare('SELECT * FROM migration_maps WHERE from_version = ? AND to_version = ? AND message_key = ?')
    .get(fromVersion, toVersion, messageKey) as Record<string, unknown> | undefined;
  if (!existing) return { ok: false, reason: 'migration map not found' };
  if (Number(existing.version) !== expectedVersion) {
    return { ok: false, conflict: true, current: Number(existing.version) };
  }
  if (String(existing.status) === 'incompatible') {
    return { ok: false, reason: 'incompatible maps cannot be approved; mark them uncompilable' };
  }
  handle.db
    .prepare('UPDATE migration_maps SET approved_by = ?, approved_at = ?, version = version + 1 WHERE id = ?')
    .run(approver, Date.now() / 1000, Number(existing.id));
  return { ok: true, version: expectedVersion + 1 };
}

export function listMigrationMaps(handle: DbHandle, fromVersion: number, toVersion: number): MigrationMapRow[] {
  return (
    handle.db
      .prepare('SELECT * FROM migration_maps WHERE from_version = ? AND to_version = ? ORDER BY message_key')
      .all(fromVersion, toVersion) as Record<string, unknown>[]
  ).map((r) => ({
    id: Number(r.id),
    fromVersion: Number(r.from_version),
    toVersion: Number(r.to_version),
    messageKey: String(r.message_key),
    payload: JSON.parse(String(r.payload_json)),
    status: String(r.status),
    version: Number(r.version),
    approvedBy: r.approved_by === null ? null : String(r.approved_by),
    approvedAt: r.approved_at === null ? null : Number(r.approved_at),
  }));
}
