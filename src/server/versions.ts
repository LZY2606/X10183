// 总线刻度 — DBC 版本生命周期与“过期解码”维护
import type Database from 'better-sqlite3';
import { buildMessages } from '../shared/dbc.js';
import type {
  DbcVersion, DbcVersionInput, MessageDef, StaleReason
} from '../shared/types.js';
import { getAllMessagesByVersion, rowToVersion } from './repo.js';

export class VersionError extends Error {}

export function listVersions(db: Database.Database): DbcVersion[] {
  const rows = db
    .prepare('SELECT * FROM dbc_versions ORDER BY COALESCE(effective_from_ns,-1), id')
    .all() as Record<string, unknown>[];
  return rows.map(rowToVersion);
}

export function getVersion(db: Database.Database, id: number): DbcVersion {
  const row = db.prepare('SELECT * FROM dbc_versions WHERE id = ?').get(id);
  if (!row) throw new VersionError(`版本 ${id} 不存在`);
  return rowToVersion(row as Record<string, unknown>);
}

function assertInterval(from: number | null, to: number | null, excludeId?: number) {
  if (from !== null && to !== null && to <= from) {
    throw new VersionError('生效区间非法：结束必须晚于开始（半开区间）');
  }
}

export function createVersion(db: Database.Database, input: DbcVersionInput): DbcVersion {
  if (!input.label?.trim()) throw new VersionError('版本 label 不能为空');
  assertInterval(input.effectiveFromNs, input.effectiveToNs);

  return db.transaction(() => {
    const createdAt = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO dbc_versions (label, effective_from_ns, effective_to_ns, note, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.label, input.effectiveFromNs, input.effectiveToNs, input.note ?? null, createdAt);
    const versionId = Number(info.lastInsertRowid);
    const messages = buildMessages(input, versionId);
    replaceMessages(db, versionId, messages);
    // 新版本改变了部分时点的生效定义 => 受影响解码过期
    markStaleForDefinitions(db, null);
    return getVersion(db, versionId);
  })();
}

/** 更新版本（修订定义/区间）；调用方须传入期望 revision 做并发冲突检测 */
export function updateVersion(
  db: Database.Database,
  id: number,
  expectedRevision: number,
  patch: Partial<DbcVersionInput>
): DbcVersion {
  const current = getVersion(db, id);
  if (current.revision !== expectedRevision) {
    throw new VersionError(
      `版本冲突：当前 revision=${current.revision}，请求基于 ${expectedRevision}`
    );
  }
  const nextFrom = patch.effectiveFromNs === undefined ? current.effectiveFromNs : patch.effectiveFromNs;
  const nextTo = patch.effectiveToNs === undefined ? current.effectiveToNs : patch.effectiveToNs;
  assertInterval(nextFrom, nextTo, id);

  return db.transaction(() => {
    db.prepare(
      `UPDATE dbc_versions
       SET label = ?, effective_from_ns = ?, effective_to_ns = ?, note = ?, revision = revision + 1
       WHERE id = ?`
    ).run(
      patch.label ?? current.label,
      nextFrom,
      nextTo,
      patch.note === undefined ? current.note : patch.note,
      id
    );
    if (patch.dbcText !== undefined || patch.messages !== undefined) {
      const messages = buildMessages(
        {
          label: patch.label ?? current.label,
          effectiveFromNs: nextFrom,
          effectiveToNs: nextTo,
          dbcText: patch.dbcText ?? null,
          messages: patch.messages
        },
        id
      );
      replaceMessages(db, id, messages);
    }
    markStaleForDefinitions(db, null);
    return getVersion(db, id);
  })();
}

export function deleteVersion(db: Database.Database, id: number, expectedRevision: number): void {
  const current = getVersion(db, id);
  if (current.revision !== expectedRevision) {
    throw new VersionError(
      `版本冲突：当前 revision=${current.revision}，请求基于 ${expectedRevision}`
    );
  }
  db.transaction(() => {
    db.prepare('DELETE FROM dbc_versions WHERE id = ?').run(id);
    markStaleForDefinitions(db, null);
  })();
}

function replaceMessages(db: Database.Database, versionId: number, messages: MessageDef[]) {
  db.prepare('DELETE FROM messages WHERE version_id = ?').run(versionId);
  const insMsg = db.prepare(
    `INSERT INTO messages (version_id, arb_id, id_kind, name, length, sender)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insSig = db.prepare(
    `INSERT INTO signals
       (message_id, version_id, name, start_bit, length, byte_order, signed, factor, offset,
        unit, min_value, max_value, mux_type, mux_value, role, crc_json, counter_modulus,
        val_table_json, ord)
     VALUES
       (@message_id, @version_id, @name, @start_bit, @length, @byte_order, @signed, @factor, @offset,
        @unit, @min_value, @max_value, @mux_type, @mux_value, @role, @crc_json, @counter_modulus,
        @val_table_json, @ord)`
  );

  const seen = new Set<string>();
  for (const msg of messages) {
    const key = `${msg.arbId}:${msg.idKind}`;
    if (seen.has(key)) {
      throw new VersionError(`版本内消息重复：arb_id=${msg.arbId} (${msg.idKind})`);
    }
    seen.add(key);
    const r = insMsg.run(versionId, msg.arbId, msg.idKind, msg.name, msg.length, msg.sender);
    const messageId = Number(r.lastInsertRowid);
    msg.signals.forEach((sig, ord) => {
      insSig.run({
        message_id: messageId,
        version_id: versionId,
        name: sig.name,
        start_bit: sig.startBit,
        length: sig.length,
        byte_order: sig.byteOrder,
        signed: sig.signed ? 1 : 0,
        factor: sig.factor,
        offset: sig.offset,
        unit: sig.unit ?? '',
        min_value: sig.min ?? null,
        max_value: sig.max ?? null,
        mux_type: sig.muxType ?? null,
        mux_value: sig.muxValue ?? null,
        role: sig.role ?? null,
        crc_json: sig.crc ? JSON.stringify(sig.crc) : null,
        counter_modulus: sig.counterModulus ?? null,
        val_table_json: JSON.stringify(sig.valTable ?? []),
        ord
      });
    });
  }
}

export function getVersionMessages(db: Database.Database, versionId: number): MessageDef[] {
  getVersion(db, versionId);
  return getAllMessagesByVersion(db).get(versionId) ?? [];
}

/**
 * 重新评估全部解码的“过期”状态。
 * 只受生效区间/定义影响；调查快照独立保存，不被改写。
 */
export function markStaleForDefinitions(db: Database.Database, _onlyVersionId: number | null) {
  const versions = listVersions(db);
  const byVersion = getAllMessagesByVersion(db);
  const decodes = db
    .prepare('SELECT * FROM decodes')
    .all() as Record<string, unknown>[];

  const frameStmt = db.prepare('SELECT hw_time_ns FROM frames WHERE id = ?');
  const update = db.prepare('UPDATE decodes SET stale_reason = ? WHERE id = ?');

  for (const dec of decodes) {
    const frame = frameStmt.get(dec.frame_id) as { hw_time_ns: number };
    const t = frame.hw_time_ns;
    const live = pickAt(versions, t);
    let reason: StaleReason = null;
    if (!live) {
      reason = 'message-removed';
    } else if (live.id !== dec.version_id) {
      reason = 'moved';
    } else {
      const msgs = byVersion.get(live.id) ?? [];
      const msg = msgs.find(
        (m) => m.arbId === dec.arb_id && m.idKind === dec.id_kind
      );
      if (!msg) {
        reason = 'message-removed';
      } else {
        const savedSig = db
          .prepare('SELECT * FROM decode_signals WHERE decode_id = ?')
          .all(dec.id) as Record<string, unknown>[];
        if (!signaturesEqual(savedSig, msg)) reason = 'changed';
      }
    }
    if (reason !== dec.stale_reason) update.run(reason, dec.id);
  }
}

export function pickAt<T extends {
  id: number;
  effectiveFromNs: number | null;
  effectiveToNs: number | null;
}>(versions: T[], t: number): T | null {
  return (
    versions.find(
      (v) =>
        (v.effectiveFromNs === null || t >= v.effectiveFromNs) &&
        (v.effectiveToNs === null || t < v.effectiveToNs)
    ) ?? null
  );
}

function signaturesEqual(saved: Record<string, unknown>[], msg: MessageDef): boolean {
  if (saved.length !== msg.signals.length) return false;
  const ordered = [...saved].sort((a, b) => (a.ord as number) - (b.ord as number));
  return ordered.every((row, i) => {
    const sig = msg.signals[i];
    if (!sig) return false;
    return (
      row.name === sig.name &&
      row.start_bit === sig.startBit &&
      row.length === sig.length &&
      row.byte_order === sig.byteOrder &&
      row.signed === (sig.signed ? 1 : 0) &&
      Number(row.factor) === sig.factor &&
      Number(row.offset) === sig.offset &&
      String(row.role ?? '') === String(sig.role ?? '') &&
      String(row.mux_type ?? '') === String(sig.muxType ?? '') &&
      (row.mux_value ?? null) === (sig.muxValue ?? null) &&
      String(row.crc_json ?? '') === (sig.crc ? JSON.stringify(sig.crc) : '') &&
      (row.counter_modulus ?? null) === (sig.counterModulus ?? null) &&
      String(row.val_table_json ?? '[]') === JSON.stringify(sig.valTable ?? [])
    );
  });
}
