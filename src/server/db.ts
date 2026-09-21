import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema';
import { contentHash } from './hash';
import { hexToBytes } from '../core/bits';
import type { FrameInput } from '../core/types';

let dbInstance: DatabaseSync | null = null;

export function getDb(path = process.env.BUS_SCALE_DB ?? 'data/bus-scale.db'): DatabaseSync {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec('PRAGMA foreign_keys = ON');
  dbInstance = db;
  return db;
}

export function reopenDb(path = process.env.BUS_SCALE_DB ?? 'data/bus-scale.db'): DatabaseSync {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  return getDb(path);
}

/* ---------------- trace 导入（顺序无关、id 确定性） ---------------- */

export interface ImportResult {
  batchId: number;
  frameIds: number[];
  duplicates: number;
  inserted: number;
}

export function importTrace(name: string, frames: FrameInput[]): ImportResult {
  const db = getDb();
  const normalized = frames.map((f) => {
    const dataHex = f.dataHex.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    hexToBytes(dataHex);
    return {
      arb_id: f.arbId,
      extended: f.extended ? 1 : 0,
      channel: f.channel,
      hw_time_ns: f.hwTimeNs,
      generation: f.generation,
      data_hex: dataHex,
    };
  });

  // 内容规范化：按 (内容 hash, 硬件时间) 排序，任何导入顺序得到相同 id。
  // 同批次内允许完全相同的帧作为独立实例（重复时间戳检测需要它们都存在），
  // 因此排序键加 occurrence；跨批次的相同内容仍命中既有帧 id。
  const seenInBatch = new Map<string, number>();
  const withHash = normalized
    .map((f) => {
      const content_hash = contentHash(f);
      const occurrence = seenInBatch.get(content_hash) ?? 0;
      seenInBatch.set(content_hash, occurrence + 1);
      return { ...f, content_hash, occurrence };
    })
    .sort(
      (a, b) =>
        a.content_hash.localeCompare(b.content_hash) ||
        a.occurrence - b.occurrence ||
        a.hw_time_ns - b.hw_time_ns,
    );

  // 既有库中每个内容 hash 已有多少实例
  const existingCount = new Map<string, number>();
  const existingIds = new Map<string, number[]>();
  for (const row of db.prepare('SELECT id, content_hash FROM frames').all() as unknown as {
    id: number;
    content_hash: string;
  }[]) {
    existingCount.set(row.content_hash, (existingCount.get(row.content_hash) ?? 0) + 1);
    const ids = existingIds.get(row.content_hash) ?? [];
    ids.push(row.id);
    existingIds.set(row.content_hash, ids);
  }
  const maxFrame = (db.prepare('SELECT COALESCE(MAX(id), 0) m FROM frames').get() as Record<string, unknown>).m as number;
  const maxBatch = (db.prepare('SELECT COALESCE(MAX(id), 0) m FROM batches').get() as Record<string, unknown>).m as number;
  const batchId = maxBatch + 1;

  db.prepare('INSERT INTO batches (id, name, imported_at_ms) VALUES (?, ?, ?)').run(
    batchId,
    name,
    Date.now() * 1_000_000,
  );

  const insert = db.prepare(
    `INSERT INTO frames (id, batch_id, arb_id, extended, channel, hw_time_ns, generation, data, data_hex, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let nextId = maxFrame + 1;
  let duplicates = 0;
  let inserted = 0;
  const frameIds: number[] = [];
  for (const f of withHash) {
    const have = existingCount.get(f.content_hash) ?? 0;
    if (f.occurrence < have) {
      // 跨批次重复：复用既有实例（按 occurrence 确定性选择）
      duplicates++;
      const id = (existingIds.get(f.content_hash) ?? [])[f.occurrence]!;
      db.prepare('INSERT OR IGNORE INTO batch_frames (batch_id, frame_id) VALUES (?, ?)').run(batchId, id);
      frameIds.push(id);
      continue;
    }
    const id = nextId++;
    insert.run(
      id,
      batchId,
      f.arb_id,
      f.extended,
      f.channel,
      f.hw_time_ns,
      f.generation,
      Buffer.from(f.data_hex, 'hex'),
      f.data_hex,
      f.content_hash,
    );
    db.prepare('INSERT OR IGNORE INTO batch_frames (batch_id, frame_id) VALUES (?, ?)').run(batchId, id);
    existingIds.set(f.content_hash, [...(existingIds.get(f.content_hash) ?? []), id]);
    existingCount.set(f.content_hash, have + 1);
    frameIds.push(id);
    inserted++;
  }
  return { batchId, frameIds, duplicates, inserted };
}
