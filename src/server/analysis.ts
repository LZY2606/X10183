import {
  decodeFrame,
  findMessage,
  type EffectiveMessage,
} from '../shared/decoder.js';
import { signalCells } from '../shared/codec.js';
import type {
  CounterConfig,
  CrcConfig,
  DecodeResult,
  IdKind,
} from '../shared/types.js';
import { messageKey } from '../shared/types.js';
import {
  checkCounter,
  checkCrc,
  type CounterReport,
  type CrcReport,
  type OrderedFrame,
} from './checks.js';
import { collectComparison, type MessageComparison } from './compare.js';
import {
  ConflictError,
  Service,
  ValidationError,
  type FrameRow,
  type RevisionRow,
  type TimelineEntry,
} from './service.js';

export interface DecodeWithMeta {
  result: DecodeResult;
  cached: boolean;
  stale: boolean;
  effectiveRevisionId: number | null;
}

/** 解码单帧：默认用采集时点的生效版本；结果缓存，过期自动标记 */
export function decodeForFrame(
  svc: Service,
  frame: FrameRow,
  revisionId?: number
): DecodeWithMeta {
  const rev = revisionId
    ? svc.getRevision(revisionId)
    : svc.effectiveRevisionAt(frame.hwTimeMs);
  const effectiveRevisionId = rev?.id ?? null;

  if (!rev) {
    return {
      result: { matched: false, signals: [], undecoded: [], reason: 'no-effective-revision' },
      cached: false,
      stale: false,
      effectiveRevisionId: null,
    };
  }

  const cached = svc.db
    .prepare('SELECT result_json FROM frame_decodes WHERE frame_id = ? AND revision_id = ?')
    .get(frame.id, rev.id) as { result_json: string } | undefined;

  if (cached) {
    return {
      result: JSON.parse(cached.result_json) as DecodeResult,
      cached: true,
      stale: false,
      effectiveRevisionId,
    };
  }

  const message = findMessage(rev.doc, frame.arbId, frame.idKind);
  const result: DecodeResult = message
    ? decodeFrame(rev.doc, eff(rev, message), frame.arbId, frame.idKind, frame.data)
    : { matched: false, signals: [], undecoded: [], reason: 'no-message-def' };

  svc.db
    .prepare(
      `INSERT INTO frame_decodes (frame_id, revision_id, decoded_at_ms, result_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(frame_id, revision_id) DO UPDATE SET result_json = excluded.result_json`
    )
    .run(frame.id, rev.id, Date.now(), JSON.stringify(result));

  return { result, cached: false, stale: false, effectiveRevisionId };
}

function eff(rev: RevisionRow, message: NonNullable<ReturnType<typeof findMessage>>): EffectiveMessage {
  return {
    message,
    revisionId: rev.id,
    revisionLabel: rev.label,
    revisionNumber: rev.revision,
  };
}

export function getTimeline(
  svc: Service,
  filter?: {
    generation?: string;
    channel?: string;
    key?: string;
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }
): TimelineEntry[] {
  const frames = svc.listFrames(filter);
  return frames.map((f) => {
    const { result, cached } = decodeForFrame(svc, f);
    return {
      ...f,
      messageKey: messageKey(f.arbId, f.idKind),
      decode: result,
      cachedDecode: cached,
    };
  });
}

export interface SeriesPoint {
  frameId: number;
  hwTimeMs: number;
  generation: string;
  raw: number;
  physical: number;
  enumLabel?: string;
  revisionId: number | null;
}

export function signalSeries(
  svc: Service,
  key: string,
  signalName: string,
  revisionId?: number
): SeriesPoint[] {
  const [idStr, kind] = key.split(':');
  const frames = svc.listFrames({ id: Number(idStr), idKind: kind as IdKind, limit: 5000 });
  const out: SeriesPoint[] = [];
  for (const f of frames) {
    const { result, effectiveRevisionId } = decodeForFrame(svc, f, revisionId);
    const sig = result.signals.find((s) => s.name === signalName);
    if (sig) {
      out.push({
        frameId: f.id,
        hwTimeMs: f.hwTimeMs,
        generation: f.generation,
        raw: sig.raw,
        physical: sig.physical,
        enumLabel: sig.enumLabel,
        revisionId: effectiveRevisionId,
      });
    }
  }
  return out;
}

function orderedFramesForKey(svc: Service, key: string): OrderedFrame[] {
  const [idStr, kind] = key.split(':');
  return svc
    .listFrames({ id: Number(idStr), idKind: kind as IdKind, limit: 10000 })
    .map((f) => ({
      id: f.id,
      data: f.data,
      hwTimeMs: f.hwTimeMs,
      seq: f.seq,
      generation: f.generation,
      channel: f.channel,
      txNode: f.txNode,
    }));
}

export function runCounterCheck(svc: Service, cfg: CounterConfig): CounterReport {
  const frames = orderedFramesForKey(svc, cfg.messageKey);
  const readCounter = (f: OrderedFrame): number | undefined => {
    const frame = svc.getFrame(f.id);
    if (!frame) return undefined;
    const rev = svc.effectiveRevisionAt(frame.hwTimeMs);
    if (!rev) return undefined;
    const msg = findMessage(rev.doc, frame.arbId, frame.idKind);
    const sig = msg?.signals.find((s) => s.name === cfg.signalName);
    if (!sig) return undefined;
    const { result } = decodeForFrame(svc, frame);
    return result.signals.find((s) => s.name === cfg.signalName)?.raw;
  };
  return checkCounter(frames, cfg, readCounter);
}

export function runCrcCheck(svc: Service, cfg: CrcConfig): CrcReport {
  const frames = orderedFramesForKey(svc, cfg.messageKey);
  const dataLen = frames.reduce((m, f) => Math.max(m, f.data.length), 0);
  const readCrc = (f: OrderedFrame): number | undefined => {
    const frame = svc.getFrame(f.id);
    if (!frame) return undefined;
    const { result } = decodeForFrame(svc, frame);
    return result.signals.find((s) => s.name === cfg.signalName)?.raw;
  };
  return checkCrc(frames, cfg, readCrc, dataLen);
}

// ---------- 快照 ----------

export interface SnapshotSummary {
  id: number;
  name: string;
  createdAtMs: number;
  frameCount: number;
  note: string | null;
}

export function createSnapshot(
  svc: Service,
  name: string,
  note?: string
): SnapshotSummary {
  const frames = svc.listFrames({ limit: 10000 });
  const info = svc.db
    .prepare('INSERT INTO snapshots (name, created_at_ms, frame_filter, note) VALUES (?, ?, ?, ?)')
    .run(name, Date.now(), JSON.stringify({}), note ?? null);
  const snapshotId = Number(info.lastInsertRowid);

  const insert = svc.db.prepare(
    `INSERT INTO snapshot_decodes (snapshot_id, frame_id, revision_id, result_json, frame_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  svc.db.exec('BEGIN');
  try {
    for (const f of frames) {
      const rev = svc.effectiveRevisionAt(f.hwTimeMs);
      const { result } = decodeForFrame(svc, f);
      insert.run(
        snapshotId,
        f.id,
        rev?.id ?? -1,
        JSON.stringify(result),
        JSON.stringify(f)
      );
    }
    svc.db.exec('COMMIT');
  } catch (e) {
    svc.db.exec('ROLLBACK');
    throw e;
  }
  return { id: snapshotId, name, createdAtMs: Date.now(), frameCount: frames.length, note: note ?? null };
}

export function listSnapshots(svc: Service): SnapshotSummary[] {
  const rows = svc.db
    .prepare(
      `SELECT s.id, s.name, s.created_at_ms, s.note, COUNT(d.frame_id) AS c
       FROM snapshots s LEFT JOIN snapshot_decodes d ON d.snapshot_id = s.id
       GROUP BY s.id ORDER BY s.id`
    )
    .all() as Array<{ id: number; name: string; created_at_ms: number; note: string | null; c: number }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAtMs: r.created_at_ms,
    frameCount: r.c,
    note: r.note,
  }));
}

export interface SnapshotEntry {
  frame: FrameRow;
  revisionId: number;
  result: DecodeResult;
}

export function getSnapshot(svc: Service, id: number): SnapshotEntry[] {
  const rows = svc.db
    .prepare(
      `SELECT frame_json, revision_id, result_json FROM snapshot_decodes
       WHERE snapshot_id = ? ORDER BY frame_id`
    )
    .all(id) as Array<{ frame_json: string; revision_id: number; result_json: string }>;
  return rows.map((r) => ({
    frame: JSON.parse(r.frame_json) as FrameRow,
    revisionId: r.revision_id,
    result: JSON.parse(r.result_json) as DecodeResult,
  }));
}

// ---------- 版本比较与迁移审批 ----------

export function compareRevisions(
  svc: Service,
  fromRevisionId: number,
  toRevisionId: number
): MessageComparison[] {
  const a = svc.getRevision(fromRevisionId);
  const b = svc.getRevision(toRevisionId);
  if (!a || !b) throw new ValidationError('版本不存在');
  return collectComparison(a.doc.messages, b.doc.messages);
}

export interface ReviewRow {
  id: number;
  fromRevisionId: number;
  toRevisionId: number;
  messageKey: string;
  status: 'pending' | 'approved' | 'incompatible';
  mapping: Record<string, string> | null;
  version: number;
  updatedAtMs: number;
}

export function getOrCreateReview(
  svc: Service,
  fromRevisionId: number,
  toRevisionId: number,
  key: string
): ReviewRow {
  const existing = svc.db
    .prepare(
      'SELECT * FROM reviews WHERE from_revision_id = ? AND to_revision_id = ? AND message_key = ?'
    )
    .get(fromRevisionId, toRevisionId, key) as Record<string, unknown> | undefined;
  if (existing) return rowToReview(existing);
  svc.db
    .prepare(
      `INSERT INTO reviews (from_revision_id, to_revision_id, message_key, status, version, updated_at_ms)
       VALUES (?, ?, ?, 'pending', 1, ?)`
    )
    .run(fromRevisionId, toRevisionId, key, Date.now());
  return getOrCreateReview(svc, fromRevisionId, toRevisionId, key);
}

export function listReviews(svc: Service): ReviewRow[] {
  const rows = svc.db.prepare('SELECT * FROM reviews ORDER BY id').all() as Record<string, unknown>[];
  return rows.map(rowToReview);
}

function rowToReview(row: Record<string, unknown>): ReviewRow {
  return {
    id: Number(row.id),
    fromRevisionId: Number(row.from_revision_id),
    toRevisionId: Number(row.to_revision_id),
    messageKey: String(row.message_key),
    status: row.status as ReviewRow['status'],
    mapping: row.mapping_json ? (JSON.parse(String(row.mapping_json)) as Record<string, string>) : null,
    version: Number(row.version),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

/**
 * 审批迁移：基于 version 的乐观锁。
 * 并发提交时 version 不匹配 => 409 冲突。
 */
export function decideReview(
  svc: Service,
  reviewId: number,
  expectedVersion: number,
  decision: 'approved' | 'incompatible',
  mapping?: Record<string, string>
): ReviewRow {
  const current = svc.db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId) as
    | Record<string, unknown>
    | undefined;
  if (!current) throw new ValidationError('审批记录不存在');
  const row = rowToReview(current);
  if (row.version !== expectedVersion) {
    throw new ConflictError(
      `版本冲突：期望 version=${expectedVersion}，当前 version=${row.version}（他人已修改）`
    );
  }
  if (decision === 'approved' && !mapping) {
    throw new ValidationError('批准迁移需要提供信号映射');
  }
  svc.db
    .prepare(
      `UPDATE reviews SET status = ?, mapping_json = ?, version = version + 1, updated_at_ms = ?
       WHERE id = ? AND version = ?`
    )
    .run(decision, mapping ? JSON.stringify(mapping) : null, Date.now(), reviewId, expectedVersion);
  const updated = svc.db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId) as Record<string, unknown>;
  return rowToReview(updated);
}

export { signalCells };
