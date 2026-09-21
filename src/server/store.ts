import { DatabaseSync } from 'node:sqlite';
import { decodeFrame, findMessage, unmatchedFrame, type DecodedFrame } from '../core/decode';
import { diffDbc, type MessageDiff } from '../core/diff';
import { checkCounter, type CounterResult } from '../core/counter';
import { hexToBytes } from '../core/bits';
import type { CanFrame, DbcDef, DbcVersionInfo } from '../core/types';

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
    create table if not exists traces(
      id integer primary key, name text not null, created_at text not null);
    create table if not exists frames(
      id integer primary key, trace_id integer not null, channel text not null,
      hw_timestamp integer not null, arbitration_id integer not null,
      extended integer not null, dlc integer not null, data text not null,
      generation integer not null);
    create table if not exists dbc_versions(
      id integer primary key, name text not null, version_num integer not null,
      effective_from integer not null, effective_to integer,
      content text not null, created_at text not null);
    create table if not exists decodes(
      id integer primary key, frame_id integer not null,
      dbc_version_id integer, result text not null, stale integer not null default 0);
    create table if not exists snapshots(
      id integer primary key, name text not null, trace_id integer not null,
      created_at text not null);
    create table if not exists snapshot_decodes(
      id integer primary key, snapshot_id integer not null, frame_id integer not null,
      dbc_version_id integer, result text not null);
    create table if not exists migrations(
      id integer primary key, from_version_id integer not null,
      to_version_id integer not null, trace_id integer not null,
      mapping text not null, status text not null default 'pending',
      version integer not null default 1, created_at text not null);
  `);
}

export interface FrameRow extends CanFrame {
  id: number;
  trace_id: number;
}

const FRAME_ORDER =
  'order by hw_timestamp, channel, arbitration_id, extended, generation, data, id';

export function importTrace(db: DB, name: string, frames: CanFrame[]): number {
  const now = new Date().toISOString();
  const t = db.prepare('insert into traces(name, created_at) values(?, ?)').run(name, now);
  const traceId = Number(t.lastInsertRowid);
  const ins = db.prepare(
    `insert into frames(trace_id, channel, hw_timestamp, arbitration_id, extended, dlc, data, generation)
     values(?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of frames) {
    ins.run(
      traceId,
      f.channel,
      f.hw_timestamp,
      f.arbitration_id,
      f.extended ? 1 : 0,
      f.dlc,
      f.data,
      f.generation,
    );
  }
  return traceId;
}

function toFrameRow(r: Record<string, unknown>): FrameRow {
  return {
    id: Number(r.id),
    trace_id: Number(r.trace_id),
    channel: String(r.channel),
    hw_timestamp: Number(r.hw_timestamp),
    arbitration_id: Number(r.arbitration_id),
    extended: Number(r.extended) === 1,
    dlc: Number(r.dlc),
    data: String(r.data),
    generation: Number(r.generation),
  };
}

export function listFrames(db: DB, traceId: number): FrameRow[] {
  const rows = db
    .prepare(`select * from frames where trace_id = ? ${FRAME_ORDER}`)
    .all(traceId) as unknown as Record<string, unknown>[];
  return rows.map(toFrameRow);
}

export function listTraces(db: DB): unknown[] {
  return db
    .prepare(
      `select t.id, t.name, t.created_at, count(f.id) as frame_count
       from traces t left join frames f on f.trace_id = t.id
       group by t.id order by t.id`,
    )
    .all();
}

export function createDbcVersion(
  db: DB,
  input: { name: string; effective_from: number; effective_to: number | null; content: DbcDef },
): number {
  const row = db.prepare('select coalesce(max(version_num), 0) as m from dbc_versions').get() as {
    m: number;
  };
  const versionNum = Number(row.m) + 1;
  const res = db
    .prepare(
      `insert into dbc_versions(name, version_num, effective_from, effective_to, content, created_at)
       values(?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      versionNum,
      input.effective_from,
      input.effective_to,
      JSON.stringify(input.content),
      new Date().toISOString(),
    );
  const id = Number(res.lastInsertRowid);
  // Only decodes whose frame falls inside the new effective interval go stale.
  db.prepare(
    `update decodes set stale = 1
     where dbc_version_id != ?
       and frame_id in (
         select id from frames
         where hw_timestamp >= ? and (? is null or hw_timestamp <= ?))`,
  ).run(id, input.effective_from, input.effective_to, input.effective_to);
  return id;
}

export function listDbcVersions(db: DB): DbcVersionInfo[] {
  const rows = db
    .prepare('select * from dbc_versions order by version_num')
    .all() as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    version_num: Number(r.version_num),
    effective_from: Number(r.effective_from),
    effective_to: r.effective_to === null ? null : Number(r.effective_to),
    content: JSON.parse(String(r.content)) as DbcDef,
  }));
}

export function getDbcVersion(db: DB, id: number): DbcVersionInfo | null {
  const r = db.prepare('select * from dbc_versions where id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    name: String(r.name),
    version_num: Number(r.version_num),
    effective_from: Number(r.effective_from),
    effective_to: r.effective_to === null ? null : Number(r.effective_to),
    content: JSON.parse(String(r.content)) as DbcDef,
  };
}

export function selectVersionFor(
  versions: DbcVersionInfo[],
  hwTimestamp: number,
): DbcVersionInfo | null {
  const candidates = versions.filter(
    (v) =>
      hwTimestamp >= v.effective_from &&
      (v.effective_to === null || hwTimestamp <= v.effective_to),
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.version_num - a.version_num);
  return candidates[0];
}

export function decodeWithVersion(
  version: DbcVersionInfo | null,
  frame: CanFrame,
): DecodedFrame {
  if (!version) return unmatchedFrame(frame.arbitration_id, frame.extended);
  const msg = findMessage(version.content, frame.arbitration_id, frame.extended);
  if (!msg) return unmatchedFrame(frame.arbitration_id, frame.extended);
  return decodeFrame(msg, hexToBytes(frame.data));
}

export function decodeTrace(db: DB, traceId: number): number {
  const versions = listDbcVersions(db);
  const frames = listFrames(db, traceId);
  db.prepare('delete from decodes where frame_id in (select id from frames where trace_id = ?)').run(
    traceId,
  );
  const ins = db.prepare(
    'insert into decodes(frame_id, dbc_version_id, result, stale) values(?, ?, ?, 0)',
  );
  for (const frame of frames) {
    const version = selectVersionFor(versions, frame.hw_timestamp);
    const result = decodeWithVersion(version, frame);
    ins.run(frame.id, version ? version.id : null, JSON.stringify(result));
  }
  return frames.length;
}

export interface DecodedRow {
  frame: FrameRow;
  dbc_version_id: number | null;
  result: DecodedFrame;
  stale: boolean;
}

export function listDecoded(db: DB, traceId: number): DecodedRow[] {
  const rows = db
    .prepare(
      `select f.*, d.id as decode_id, d.dbc_version_id, d.result, d.stale
       from frames f join decodes d on d.frame_id = f.id
       where f.trace_id = ? ${FRAME_ORDER.replace('order by', 'order by f.')}`,
    )
    .all(traceId) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    frame: toFrameRow(r),
    dbc_version_id: r.dbc_version_id === null ? null : Number(r.dbc_version_id),
    result: JSON.parse(String(r.result)) as DecodedFrame,
    stale: Number(r.stale) === 1,
  }));
}

export interface CounterReport {
  node: string;
  message: string;
  signal: string;
  generation: number;
  result: CounterResult;
}

export function counterReports(db: DB, traceId: number): CounterReport[] {
  const decoded = listDecoded(db, traceId).filter((d) => !d.stale);
  const versions = new Map(listDbcVersions(db).map((v) => [v.id, v]));
  const groups = new Map<string, { meta: CounterReport['result'] extends never ? never : { node: string; message: string; signal: string; generation: number; bitLength: number }; samples: { raw: number; hw_timestamp: number }[] }>();
  for (const d of decoded) {
    if (!d.result.matched || d.dbc_version_id === null) continue;
    const version = versions.get(d.dbc_version_id);
    if (!version) continue;
    const msg = findMessage(version.content, d.frame.arbitration_id, d.frame.extended);
    if (!msg) continue;
    for (const sig of msg.signals) {
      if (sig.role !== 'counter') continue;
      const ds = d.result.signals.find((s) => s.name === sig.name);
      if (!ds || ds.status !== 'ok') continue;
      const node = msg.senders[0] ?? 'unknown';
      const key = `${node}|${msg.name}|${sig.name}|${d.frame.generation}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          meta: { node, message: msg.name, signal: sig.name, generation: d.frame.generation, bitLength: sig.length },
          samples: [],
        };
        groups.set(key, g);
      }
      g.samples.push({ raw: Number(ds.raw_unsigned), hw_timestamp: d.frame.hw_timestamp });
    }
  }
  const reports: CounterReport[] = [];
  for (const g of [...groups.values()].sort((a, b) =>
    `${a.meta.node}${a.meta.message}${a.meta.signal}${a.meta.generation}`.localeCompare(
      `${b.meta.node}${b.meta.message}${b.meta.signal}${b.meta.generation}`,
    ),
  )) {
    reports.push({
      node: g.meta.node,
      message: g.meta.message,
      signal: g.meta.signal,
      generation: g.meta.generation,
      result: checkCounter(g.samples, g.meta.bitLength),
    });
  }
  return reports;
}

export interface CrcRow {
  frame: FrameRow;
  evidence: DecodedFrame['crc'];
  message: string | null;
}

export function crcEvidence(db: DB, traceId: number): CrcRow[] {
  return listDecoded(db, traceId)
    .filter((d) => d.result.crc)
    .map((d) => ({ frame: d.frame, evidence: d.result.crc, message: d.result.message }));
}

export interface CompareResult {
  trace_id: number;
  from_version: number;
  to_version: number;
  message_diffs: MessageDiff[];
  frames_compared: number;
  frames_with_value_changes: number;
}

export function compareVersions(
  db: DB,
  traceId: number,
  fromId: number,
  toId: number,
): CompareResult | null {
  const a = getDbcVersion(db, fromId);
  const b = getDbcVersion(db, toId);
  if (!a || !b) return null;
  const frames = listFrames(db, traceId);
  let changed = 0;
  for (const frame of frames) {
    const ra = decodeWithVersion(a, frame);
    const rb = decodeWithVersion(b, frame);
    if (JSON.stringify(ra.signals) !== JSON.stringify(rb.signals)) changed++;
  }
  return {
    trace_id: traceId,
    from_version: fromId,
    to_version: toId,
    message_diffs: diffDbc(a.content, b.content),
    frames_compared: frames.length,
    frames_with_value_changes: changed,
  };
}

export class ConflictError extends Error {}

export function createMigration(
  db: DB,
  input: { from_version_id: number; to_version_id: number; trace_id: number; mapping: unknown },
): number {
  const res = db
    .prepare(
      `insert into migrations(from_version_id, to_version_id, trace_id, mapping, status, version, created_at)
       values(?, ?, ?, ?, 'pending', 1, ?)`,
    )
    .run(
      input.from_version_id,
      input.to_version_id,
      input.trace_id,
      JSON.stringify(input.mapping),
      new Date().toISOString(),
    );
  return Number(res.lastInsertRowid);
}

export function listMigrations(db: DB): unknown[] {
  return db.prepare('select * from migrations order by id').all();
}

export function setMigrationStatus(
  db: DB,
  id: number,
  expectedVersion: number,
  status: 'approved' | 'incompatible',
): void {
  const row = db.prepare('select version from migrations where id = ?').get(id) as
    | { version: number }
    | undefined;
  if (!row) throw new Error('migration_not_found');
  if (Number(row.version) !== expectedVersion) {
    throw new ConflictError(
      `version conflict: expected ${expectedVersion}, current ${row.version}`,
    );
  }
  db.prepare('update migrations set status = ?, version = version + 1 where id = ? and version = ?').run(
    status,
    id,
    expectedVersion,
  );
}

export function createSnapshot(db: DB, traceId: number, name: string): number {
  const res = db
    .prepare('insert into snapshots(name, trace_id, created_at) values(?, ?, ?)')
    .run(name, traceId, new Date().toISOString());
  const snapshotId = Number(res.lastInsertRowid);
  const decoded = listDecoded(db, traceId);
  const ins = db.prepare(
    'insert into snapshot_decodes(snapshot_id, frame_id, dbc_version_id, result) values(?, ?, ?, ?)',
  );
  for (const d of decoded) {
    ins.run(snapshotId, d.frame.id, d.dbc_version_id, JSON.stringify(d.result));
  }
  return snapshotId;
}

export function getSnapshot(db: DB, id: number): unknown {
  const snap = db.prepare('select * from snapshots where id = ?').get(id);
  if (!snap) return null;
  const rows = db
    .prepare(
      `select sd.frame_id, sd.dbc_version_id, sd.result, f.hw_timestamp, f.arbitration_id
       from snapshot_decodes sd join frames f on f.id = sd.frame_id
       where sd.snapshot_id = ? order by f.hw_timestamp, f.id`,
    )
    .all(id);
  return { snapshot: snap, decodes: rows };
}
