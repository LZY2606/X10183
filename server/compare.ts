import type { DB } from './db.js';
import type {
  MessageDiff,
  Migration,
  MigrationStatus,
  SignalDef,
  Snapshot,
  VersionComparison
} from '../src/types.js';
import { listFramesOrdered, loadDbcVersion } from './repo.js';
import { decodeFrameAtTime, decodeFrameWithDbc } from './decode.js';

const SIG_FIELDS: (keyof SignalDef)[] = [
  'startBit', 'length', 'byteOrder', 'signed', 'scale', 'offset', 'unit', 'muxType', 'muxSwitch'
];

function pick(sig: SignalDef | null): Partial<SignalDef> | null {
  if (!sig) return null;
  const out: Partial<SignalDef> = {
    startBit: sig.startBit,
    length: sig.length,
    byteOrder: sig.byteOrder,
    signed: sig.signed,
    scale: sig.scale,
    offset: sig.offset,
    unit: sig.unit,
    muxType: sig.muxType,
    muxSwitch: sig.muxSwitch,
    enums: sig.enums
  };
  return out;
}

export function compareVersions(db: DB, fromDbcId: number, toDbcId: number): VersionComparison {
  const from = loadDbcVersion(db, fromDbcId);
  const to = loadDbcVersion(db, toDbcId);
  if (!from || !to) throw new Error('DBC 版本不存在');

  const keys = new Set([
    ...from.messages.map((m) => msgKey(m.arbId, m.extended)),
    ...to.messages.map((m) => msgKey(m.arbId, m.extended))
  ]);

  const messages: MessageDiff[] = [];
  for (const k of [...keys].sort()) {
    const [arbId, ext] = parseKey(k);
    const a = from.messages.find((m) => m.arbId === arbId && m.extended === ext) ?? null;
    const b = to.messages.find((m) => m.arbId === arbId && m.extended === ext) ?? null;
    const sigNames = new Set([...(a?.signals ?? []).map((s) => s.name), ...(b?.signals ?? []).map((s) => s.name)]);
    const sigDiffs = [...sigNames].sort().map((name) => {
      const sa = a?.signals.find((s) => s.name === name) ?? null;
      const sb = b?.signals.find((s) => s.name === name) ?? null;
      const status = (!sa ? 'added' : !sb ? 'removed' : sameSignal(sa, sb) ? 'identical' : 'changed') as
        'added' | 'removed' | 'changed' | 'identical';
      return { name, from: pick(sa), to: pick(sb), status };
    });
    const status: MessageDiff['status'] = !a
      ? 'added'
      : !b
        ? 'removed'
        : sigDiffs.every((s) => s.status === 'identical') && a.name === b!.name && a.dlc === b!.dlc
          ? 'identical'
          : 'changed';
    messages.push({ key: k, messageName: b?.name ?? a?.name ?? `0x${arbId.toString(16)}`, arbId, extended: ext, status, signals: sigDiffs });
  }

  const frames = listFramesOrdered(db);
  return { fromDbcId, toDbcId, framesCompared: frames.length, messages };
}

function sameSignal(a: SignalDef, b: SignalDef): boolean {
  for (const f of SIG_FIELDS) {
    if (a[f] !== b[f]) return false;
  }
  return JSON.stringify(a.enums) === JSON.stringify(b.enums);
}

export function decodeImpact(db: DB, fromDbcId: number, toDbcId: number) {
  const from = loadDbcVersion(db, fromDbcId)!;
  const to = loadDbcVersion(db, toDbcId)!;
  return listFramesOrdered(db).map((f) => ({
    frameId: f.id,
    hwTime: f.hwTime,
    arbId: f.arbId,
    extended: f.extended,
    from: summarize(decodeFrameWithDbc(f, from)),
    to: summarize(decodeFrameWithDbc(f, to))
  }));
}

function summarize(d: ReturnType<typeof decodeFrameWithDbc>) {
  return {
    messageName: d.messageName,
    signals: d.signals.map((s) => ({ name: s.name, active: s.active, raw: s.raw, physical: s.physical, enumLabel: s.enumLabel }))
  };
}

export function msgKey(arbId: number, extended: boolean): string {
  return `${extended ? 'x' : 's'}-${arbId}`;
}
function parseKey(k: string): [number, boolean] {
  const [t, id] = k.split('-');
  return [parseInt(id, 10), t === 'x'];
}

export function createMigration(db: DB, fromDbcId: number, toDbcId: number): Migration {
  const existing = db
    .prepare('SELECT id FROM migrations WHERE from_dbc_id = ? AND to_dbc_id = ?')
    .get(fromDbcId, toDbcId) as { id: number } | undefined;
  if (existing) return getMigration(db, existing.id)!;
  const comparison = compareVersions(db, fromDbcId, toDbcId);
  const info = db
    .prepare('INSERT INTO migrations (from_dbc_id, to_dbc_id, mapping) VALUES (?, ?, ?)')
    .run(fromDbcId, toDbcId, JSON.stringify(comparison.messages));
  return getMigration(db, Number(info.lastInsertRowid))!;
}

function rowToMigration(r: Record<string, unknown>): Migration {
  return {
    id: r.id as number,
    fromDbcId: r.from_dbc_id as number,
    toDbcId: r.to_dbc_id as number,
    status: r.status as MigrationStatus,
    rationale: r.rationale as string,
    mapping: JSON.parse(r.mapping as string) as MessageDiff[],
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  };
}

export function getMigration(db: DB, id: number): Migration | null {
  const row = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
  return row ? rowToMigration(row as Record<string, unknown>) : null;
}

export function listMigrations(db: DB): Migration[] {
  return (db.prepare('SELECT * FROM migrations ORDER BY id').all() as Record<string, unknown>[]).map(rowToMigration);
}

export interface MigrationDecision {
  status: Extract<MigrationStatus, 'approved' | 'incompatible'>;
  rationale?: string;
  expectedVersion: number;
}

export function decideMigration(db: DB, id: number, decision: MigrationDecision): Migration {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('迁移映射不存在');
    if (row.version !== decision.expectedVersion) {
      const err = new Error(`版本冲突：当前版本 ${row.version}，你基于 ${decision.expectedVersion} 审批`);
      (err as Error & { code?: string }).code = 'VERSION_CONFLICT';
      throw err;
    }
    if (row.status !== 'open') {
      const err = new Error(`迁移映射已结束（${row.status}），不可重复审批`);
      (err as Error & { code?: string }).code = 'ALREADY_DECIDED';
      throw err;
    }
    db.prepare(
      `UPDATE migrations SET status = ?, rationale = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`
    ).run(decision.status, decision.rationale ?? '', id);
    return getMigration(db, id)!;
  });
  return tx();
}

export interface SnapshotInput {
  title: string;
  note?: string;
}

// 冻结调查快照：逐帧保存当时完整解码，DBC 修订后仍指向旧定义
export function createSnapshot(db: DB, input: SnapshotInput): Snapshot {
  const payload = listFramesOrdered(db).map((f) => {
    const decoded = decodeFrameAtTime(f, db);
    return {
      frameId: f.id,
      arbId: f.arbId,
      extended: f.extended,
      hwTime: f.hwTime,
      channel: f.channel,
      dataHex: f.data.map((b) => b.toString(16).padStart(2, '0')).join(''),
      dbcId: decoded.dbcId,
      dbcLabel: decoded.dbcLabel,
      messageName: decoded.messageName,
      signals: decoded.signals.map((s) => ({
        name: s.name,
        active: s.active,
        reason: s.reason,
        raw: s.raw,
        rawBits: s.rawBits,
        bitCells: s.bitCells,
        physical: s.physical,
        enumLabel: s.enumLabel,
        muxType: s.muxType,
        byteOrder: s.byteOrder
      }))
    };
  });
  const info = db
    .prepare('INSERT INTO snapshots (title, note, frame_count, payload) VALUES (?, ?, ?, ?)')
    .run(input.title, input.note ?? '', payload.length, JSON.stringify(payload));
  return getSnapshot(db, Number(info.lastInsertRowid))!;
}

export function getSnapshot(db: DB, id: number): Snapshot | null {
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as
    | { id: number; title: string; note: string; created_at: string; frame_count: number; payload: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, title: row.title, note: row.note, createdAt: row.created_at, frameCount: row.frame_count, payload: JSON.parse(row.payload) };
}

export function listSnapshots(db: DB): Omit<Snapshot, 'payload'>[] {
  return db
    .prepare('SELECT id, title, note, created_at, frame_count FROM snapshots ORDER BY id')
    .all() as Omit<Snapshot, 'payload'>[];
}
