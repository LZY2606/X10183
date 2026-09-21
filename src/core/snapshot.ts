import type { DatabaseSync } from "node:sqlite";
import { replay } from "./replay";
import { listVersions } from "../server/repo";
import { selectVersionAt } from "./version";
import type { Snapshot } from "./types";

interface SnapshotRow {
  id: number;
  name: string;
  created_at: number;
  payload: string;
}

/** 冻结调查快照：把每帧当时使用的确切 DBC 版本固化；之后 DBC 修订不影响快照。 */
export function createSnapshot(db: DatabaseSync, name: string, frameIds?: number[]): Snapshot {
  const decoded = replay(db);
  const wanted = frameIds ? new Set(frameIds) : null;
  const entries = decoded
    .filter((f) => !wanted || wanted.has(f.frameId))
    .map((f) => ({
      frameId: f.frameId,
      dbcVersionId: f.dbcVersionId,
      messageName: f.messageName,
      error: f.error,
    }));
  const createdAt = Date.now();
  const info = db
    .prepare("INSERT INTO snapshots(name, created_at, payload) VALUES (?,?,?)")
    .run(name, createdAt, JSON.stringify(entries));
  return { id: Number(info.lastInsertRowid), name, createdAt, entries };
}

export function listSnapshots(db: DatabaseSync): Snapshot[] {
  const rows = db.prepare("SELECT * FROM snapshots ORDER BY id").all() as SnapshotRow[];
  return rows.map(rowToSnapshot);
}

export function getSnapshot(db: DatabaseSync, id: number): Snapshot | null {
  const r = db.prepare("SELECT * FROM snapshots WHERE id=?").get(id) as SnapshotRow | undefined;
  return r ? rowToSnapshot(r) : null;
}

function rowToSnapshot(r: SnapshotRow): Snapshot {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    entries: JSON.parse(r.payload) as Snapshot["entries"],
  };
}

/**
 * 快照过期分析：冻结条目继续指向旧定义；
 * 若按当前 DBC 集合、该帧硬件时间会选中不同版本，则标记为 expired。
 */
export function snapshotStaleness(
  db: DatabaseSync,
  snapshot: Snapshot,
): { frameId: number; frozenVersionId: number; currentVersionId: number | null; expired: boolean }[] {
  const versions = listVersions(db);
  const times = new Map<number, number>();
  for (const f of replay(db)) times.set(f.frameId, f.hwTime);
  return snapshot.entries.map((e) => {
    const t = times.get(e.frameId);
    const current = t === undefined ? null : selectVersionAt(versions, t);
    return {
      frameId: e.frameId,
      frozenVersionId: e.dbcVersionId,
      currentVersionId: current?.id ?? null,
      expired: current ? current.id !== e.dbcVersionId : true,
    };
  });
}
