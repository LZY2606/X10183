// 总线刻度 — 冻结的调查快照：DBC 修订后仍继续指向旧定义
import type Database from 'better-sqlite3';
import type { Snapshot, SnapshotPayload } from '../shared/types.js';
import { queryDecodes } from './decode.js';
import { listVersions } from './versions.js';

export function createSnapshot(db: Database.Database, label: string): Snapshot {
  const now = Date.now() * 1e6;
  const decodes = queryDecodes(db);
  const versionIds = [...new Set(decodes.map((d) => d.versionId))].sort((a, b) => a - b);
  const payload: SnapshotPayload = {
    frozenAtNs: now,
    decodes,
    versions: listVersions(db)
  };
  const info = db
    .prepare(
      `INSERT INTO investigations
         (label, created_at, frozen_at_ns, frame_count, version_ids_json, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      label || `调查快照 ${new Date().toISOString()}`,
      new Date().toISOString(),
      now,
      decodes.length,
      JSON.stringify(versionIds),
      JSON.stringify(payload)
    );
  return getSnapshot(db, Number(info.lastInsertRowid));
}

export function listSnapshots(db: Database.Database): Omit<Snapshot, 'payload'>[] {
  const rows = db
    .prepare(
      `SELECT id, label, created_at, frozen_at_ns, frame_count, version_ids_json
       FROM investigations ORDER BY id DESC`
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as number,
    label: row.label as string,
    createdAt: row.created_at as string,
    frameCount: row.frame_count as number,
    versionIds: JSON.parse(row.version_ids_json as string) as number[]
  })) as Omit<Snapshot, 'payload'>[];
}

export function getSnapshot(db: Database.Database, id: number): Snapshot {
  const row = db.prepare('SELECT * FROM investigations WHERE id = ?').get(id);
  if (!row) throw new Error(`快照 ${id} 不存在`);
  const r = row as Record<string, unknown>;
  return {
    id: r.id as number,
    label: r.label as string,
    createdAt: r.created_at as string,
    frameCount: r.frame_count as number,
    versionIds: JSON.parse(r.version_ids_json as string) as number[],
    payload: JSON.parse(r.payload_json as string) as SnapshotPayload
  };
}
