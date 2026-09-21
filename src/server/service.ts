import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  decodeFrame,
  findMessage,
  type EffectiveMessage,
} from '../shared/decoder.js';
import { readBits, signalCells } from '../shared/codec.js';
import type {
  DbcDoc,
  DbcRevisionInput,
  DecodeResult,
  IdKind,
  MessageDef,
  RawFrameInput,
  SignalDef,
} from '../shared/types.js';
import { messageKey, normalizeIdKind } from '../shared/types.js';
import { parseTraceInput } from './traceParse.js';
import { looksLikeDbcText, parseDbcText } from './dbcText.js';

export interface FrameRow {
  id: number;
  arbId: number;
  idKind: IdKind;
  channel: string;
  hwTimeMs: number;
  generation: string;
  txNode: string | null;
  data: number[];
  importId: number;
  seq: number;
}

export interface RevisionRow {
  id: number;
  label: string;
  revision: number;
  effectiveStartMs: number;
  effectiveEndMs: number | null;
  importedAtMs: number;
  doc: DbcDoc;
}

export interface TimelineEntry extends FrameRow {
  messageKey: string;
  decode: DecodeResult;
  cachedDecode: boolean;
}

export class Service {
  private stmts = new Map<string, StatementSync>();

  constructor(public readonly db: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // ---------- Trace 导入 ----------

  importTrace(text: string, opts: { format?: string; note?: string } = {}): {
    importId: number;
    frameCount: number;
  } {
    const parsed = parseTraceInput(text);
    return this.importFrames(parsed, opts);
  }

  importFrames(
    rows: RawFrameInput[],
    opts: { format?: string; note?: string } = {}
  ): { importId: number; importId: number; frameCount: number } {
    const now = Date.now();
    const importResult = this.stmt(
      `INSERT INTO trace_imports (imported_at_ms, format, frame_count, note)
       VALUES (?, ?, 0, ?)`
    ).run(now, opts.format ?? 'json', opts.note ?? null);
    const importId = Number(importResult.lastInsertRowid);

    // 先规范化并按硬件时间稳定排序，保证导入顺序不影响 seq
    const normalized = rows.map((r) => normalizeFrame(r));
    normalized.sort((a, b) => compareFrames(a, b));

    const maxSeqRow = this.stmt('SELECT COALESCE(MAX(seq), -1) AS m FROM frames').get() as {
      m: number;
    };
    let seq = maxSeqRow.m + 1;

    const insertFrame = this.stmt(
      `INSERT INTO frames
         (arb_id, id_kind, channel, hw_time_ms, generation, tx_node, data, import_id, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertGen = this.stmt(
      `INSERT INTO generations (name, first_seen_ms) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms)`
    );

    const tx = this.db;
    tx.exec('BEGIN');
    try {
      for (const f of normalized) {
        upsertGen.run(f.generation, f.hwTimeMs);
        insertFrame.run(
          f.arbId,
          f.idKind,
          f.channel,
          f.hwTimeMs,
          f.generation,
          f.txNode,
          JSON.stringify(f.data),
          importId,
          seq++
        );
      }
      this.stmt('UPDATE trace_imports SET frame_count = ? WHERE id = ?').run(
        normalized.length,
        importId
      );
      tx.exec('COMMIT');
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
    return { importId, frameCount: normalized.length };
  }

  // ---------- DBC 版本 ----------

  /**
   * 导入一个带生效区间的 DBC 版本（版本内容不可变）。
   * 同 label 的新区间与既有区间不得重叠；revision 号在 label 内需递增。
   */
  importDbc(input: DbcRevisionInput): RevisionRow {
    const doc = normalizeDoc(input.doc);
    validateInterval(input.effectiveStartMs, input.effectiveEndMs);

    const sameLabel = this.listRevisions().filter((r) => r.label === input.label);
    if (sameLabel.some((r) => r.revision === input.revision)) {
      throw new ConflictError(`DBC 版本号 ${input.label}#${input.revision} 已存在`);
    }
    if (
      sameLabel.length > 0 &&
      input.revision <= Math.max(...sameLabel.map((r) => r.revision))
    ) {
      throw new ConflictError(
        `版本号必须递增（${input.label} 已有更高版本）`
      );
    }
    for (const r of sameLabel) {
      if (intervalsOverlap(
        [input.effectiveStartMs, input.effectiveEndMs],
        [r.effectiveStartMs, r.effectiveEndMs]
      )) {
        throw new ConflictError(
          `生效区间与 ${input.label}#${r.revision} 重叠：${describeInterval(r.effectiveStartMs, r.effectiveEndMs)}`
        );
      }
    }

    const result = this.stmt(
      `INSERT INTO dbc_revisions
         (label, revision, effective_start_ms, effective_end_ms, imported_at_ms, doc_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.label,
      input.revision,
      input.effectiveStartMs,
      input.effectiveEndMs,
      Date.now(),
      JSON.stringify(doc)
    );
    return this.getRevision(Number(result.lastInsertRowid))!;
  }

  importDbcText(
    text: string,
    meta: {
      label: string;
      revision: number;
      effectiveStartMs: number;
      effectiveEndMs: number | null;
    }
  ): RevisionRow {
    const doc = parseDbcText(text);
    return this.importDbc({ ...meta, doc });
  }

  listRevisions(): RevisionRow[] {
    const rows = this.stmt(
      `SELECT id, label, revision, effective_start_ms, effective_end_ms, imported_at_ms, doc_json
       FROM dbc_revisions ORDER BY effective_start_ms, label, revision`
    ).all() as Record<string, unknown>[];
    return rows.map(rowToRevision);
  }

  getRevision(id: number): RevisionRow | undefined {
    const row = this.stmt(
      `SELECT id, label, revision, effective_start_ms, effective_end_ms, imported_at_ms, doc_json
       FROM dbc_revisions WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;
    return row ? rowToRevision(row) : undefined;
  }

  /** 按采集时点选择生效版本：区间含端点；多版本命中时取 revision 最大者 */
  effectiveRevisionAt(hwTimeMs: number): RevisionRow | undefined {
    const rows = this.stmt(
      `SELECT id, label, revision, effective_start_ms, effective_end_ms, imported_at_ms, doc_json
       FROM dbc_revisions
       WHERE effective_start_ms <= ? AND (effective_end_ms IS NULL OR effective_end_ms >= ?)
       ORDER BY revision DESC, id DESC`
    ).all(hwTimeMs, hwTimeMs) as Record<string, unknown>[];
    return rows.length ? rowToRevision(rows[0]) : undefined;
  }

  /** 找帧在某版本中的消息定义（标准/扩展不混淆） */
  messageDefIn(rev: RevisionRow, id: number, kind: IdKind): MessageDef | undefined {
    return findMessage(rev.doc, id, kind);
  }

  // ---------- 帧查询 ----------

  listFrames(filter?: {
    generation?: string;
    channel?: string;
    key?: string;
    id?: number;
    idKind?: IdKind;
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }): FrameRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.generation) {
      where.push('generation = ?');
      params.push(filter.generation);
    }
    if (filter?.channel) {
      where.push('channel = ?');
      params.push(filter.channel);
    }
    const keyId = filter?.id ?? (filter?.key ? Number(filter.key.split(':')[0]) : undefined);
    const keyKind = filter?.idKind ?? (filter?.key ? (filter.key.split(':')[1] as IdKind) : undefined);
    if (typeof keyId === 'number') {
      where.push('arb_id = ?');
      params.push(keyId);
    }
    if (keyKind) {
      where.push('id_kind = ?');
      params.push(keyKind);
    }
    if (typeof filter?.fromMs === 'number') {
      where.push('hw_time_ms >= ?');
      params.push(filter.fromMs);
    }
    if (typeof filter?.toMs === 'number') {
      where.push('hw_time_ms <= ?');
      params.push(filter.toMs);
    }
    const limit = Math.min(filter?.limit ?? 2000, 10000);
    const rows = this.stmt(
      `SELECT id, arb_id, id_kind, channel, hw_time_ms, generation, tx_node, data, import_id, seq
       FROM frames ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY hw_time_ms, seq LIMIT ?`
    ).all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToFrame);
  }

  getFrame(id: number): FrameRow | undefined {
    const row = this.stmt(
      `SELECT id, arb_id, id_kind, channel, hw_time_ms, generation, tx_node, data, import_id, seq
       FROM frames WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;
    return row ? rowToFrame(row) : undefined;
  }

  listGenerations(): Array<{ name: string; firstSeenMs: number; frameCount: number }> {
    const rows = this.stmt(
      `SELECT g.name, g.first_seen_ms AS firstSeenMs, COUNT(f.id) AS frameCount
       FROM generations g LEFT JOIN frames f ON f.generation = g.name
       GROUP BY g.name ORDER BY g.first_seen_ms, g.name`
    ).all() as Array<{ name: string; firstSeenMs: number; frameCount: number }>;
    return rows;
  }

  listImports(): Array<{ id: number; importedAtMs: number; format: string; frameCount: number; note: string | null }> {
    const rows = this.stmt(
      `SELECT id, imported_at_ms AS importedAtMs, format, frame_count AS frameCount, note
       FROM trace_imports ORDER BY id`
    ).all() as Array<{ id: number; importedAtMs: number; format: string; frameCount: number; note: string | null }>;
    return rows;
  }
}

function rowToFrame(row: Record<string, unknown>): FrameRow {
  return {
    id: Number(row.id),
    arbId: Number(row.arb_id),
    idKind: row.id_kind as IdKind,
    channel: String(row.channel),
    hwTimeMs: Number(row.hw_time_ms),
    generation: String(row.generation),
    txNode: (row.tx_node as string | null) ?? null,
    data: JSON.parse(String(row.data)) as number[],
    importId: Number(row.import_id),
    seq: Number(row.seq),
  };
}

export class ConflictError extends Error {
  status = 409;
}

export class ValidationError extends Error {
  status = 400;
}

function rowToRevision(row: Record<string, unknown>): RevisionRow {
  return {
    id: Number(row.id),
    label: String(row.label),
    revision: Number(row.revision),
    effectiveStartMs: Number(row.effective_start_ms),
    effectiveEndMs: row.effective_end_ms == null ? null : Number(row.effective_end_ms),
    importedAtMs: Number(row.imported_at_ms),
    doc: JSON.parse(String(row.doc_json)) as DbcDoc,
  };
}

interface NormalFrame {
  arbId: number;
  idKind: IdKind;
  channel: string;
  hwTimeMs: number;
  generation: string;
  txNode: string | null;
  data: number[];
}

function normalizeFrame(r: RawFrameInput): NormalFrame {
  const rawId = typeof r.id === 'number' ? r.id : parseIdToken(String(r.id));
  const arbId = rawId >>> 0;
  const idKind = r.idKind ?? normalizeIdKind(arbId);
  const data = Array.isArray(r.data)
    ? r.data.map((b) => Number(b))
    : parseHexBytes(String(r.data));
  const hwTimeMs =
    typeof r.hwTimeMs === 'number'
      ? Math.round(r.hwTimeMs)
      : typeof r.hwTimeSec === 'number'
        ? Math.round(r.hwTimeSec * 1000)
        : 0;
  const generation =
    r.generation === undefined || r.generation === ''
      ? 'G1'
      : String(r.generation);
  return {
    arbId,
    idKind,
    channel: String(r.channel ?? '0'),
    hwTimeMs,
    generation,
    txNode: r.txNode ? String(r.txNode) : null,
    data,
  };
}

function compareFrames(a: NormalFrame, b: NormalFrame): number {
  return (
    a.hwTimeMs - b.hwTimeMs ||
    a.arbId - b.arbId ||
    a.idKind.localeCompare(b.idKind) ||
    a.channel.localeCompare(b.channel) ||
    a.generation.localeCompare(b.generation) ||
    (a.txNode ?? '').localeCompare(b.txNode ?? '')
  );
}

function parseIdToken(s: string): number {
  const t = s.trim();
  return /^0x/i.test(t) || /[a-f]/i.test(t) ? parseInt(t, 16) : Number(t);
}

function parseHexBytes(s: string): number[] {
  return s
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => {
      const n = /^0x/i.test(t) || /[a-f]/i.test(t) ? parseInt(t, 16) : Number(t);
      return n & 0xff;
    });
}

function normalizeDoc(doc: DbcDoc): DbcDoc {
  for (const msg of doc.messages) {
    msg.id = msg.id >>> 0;
    msg.idKind = msg.idKind ?? normalizeIdKind(msg.id);
    for (const sig of msg.signals) {
      sig.factor = sig.factor ?? 1;
      sig.offset = sig.offset ?? 0;
    }
  }
  return doc;
}

function validateInterval(start: number, end: number | null): void {
  if (!Number.isFinite(start)) throw new ValidationError('生效起点无效');
  if (end !== null && (!Number.isFinite(end) || end < start)) {
    throw new ValidationError('生效终点无效（必须 >= 起点，端点含边界）');
  }
}

function intervalsOverlap(
  a: [number, number | null],
  b: [number, number | null]
): boolean {
  if (a[1] !== null && b[0] > a[1]) return false;
  if (b[1] !== null && a[0] > b[1]) return false;
  return true;
}

function describeInterval(start: number, end: number | null): string {
  return `[${start}, ${end ?? '∞'}]`;
}

export function parseDbcPayload(text: string): DbcDoc {
  return looksLikeDbcText(text) ? parseDbcText(text) : (JSON.parse(text) as DbcDoc);
}

// 供 checks 使用：从某版本定义中读取一个信号的 raw 值
export function readSignalRaw(
  msg: MessageDef,
  sigName: string,
  data: number[]
): number | undefined {
  const sig = msg.signals.find((s) => s.name === sigName);
  if (!sig) return undefined;
  return readBits(data, signalCells(sig));
}

export function signalDefOf(msg: MessageDef | undefined, name: string): SignalDef | undefined {
  return msg?.signals.find((s) => s.name === name);
}

export type { EffectiveMessage };
export { decodeFrame, messageKey };
