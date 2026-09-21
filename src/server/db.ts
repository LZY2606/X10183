import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseDbc } from '../core/dbc.js';
import { resolveVersion } from '../core/versions.js';
import type { DbcDocument, MessageDef, RawFrame, SignalDef } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, 'schema.sql');

export interface DbHandle {
  db: DatabaseSync;
  close(): void;
}

export function openDatabase(path: string): DbHandle {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(schemaPath, 'utf8'));
  return {
    db,
    close: () => db.close(),
  };
}

export function hashDefinition(doc: DbcDocument): string {
  return createHash('sha256').update(JSON.stringify(doc.messages)).digest('hex').slice(0, 16);
}

export interface StoredDbcVersion {
  id: number;
  versionNumber: number;
  label: string;
  validFrom: number;
  validTo: number | null;
  sourceName: string;
  definitionHash: string;
  importedAt: number;
}

function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function storeDbc(
  handle: DbHandle,
  content: string,
  meta: { versionNumber: number; label: string; validFrom: number; validTo?: number | null; sourceName: string }
): StoredDbcVersion {
  const { db } = handle;
  const doc = parseDbc(content, meta.sourceName);
  const hash = hashDefinition(doc);
  return withTx(db, () => {
    const exists = db.prepare('SELECT id FROM dbc_versions WHERE version_number = ?').get(meta.versionNumber);
    if (exists) throw new Error(`DBC version number ${meta.versionNumber} already exists`);
    const info = db
      .prepare(
        `INSERT INTO dbc_versions (version_number, label, valid_from, valid_to, source_name, content, definition_hash, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        meta.versionNumber,
        meta.label,
        meta.validFrom,
        meta.validTo ?? null,
        meta.sourceName,
        content,
        hash,
        Date.now() / 1000
      );
    const versionId = Number(info.lastInsertRowid);

    const insMsg = db.prepare(
      `INSERT INTO messages (dbc_version_id, arbitration_id, is_extended, name, dlc, transmitter)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insSig = db.prepare(
      `INSERT INTO signals (message_id, name, start_bit, length, byte_order, value_type, factor, offset, unit, mux_kind, mux_switch_name, mux_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insEnum = db.prepare('INSERT INTO signal_enums (signal_id, value, name) VALUES (?, ?, ?)');

    for (const msg of doc.messages) {
      const msgInfo = insMsg.run(versionId, msg.messageId, msg.isExtended ? 1 : 0, msg.name, msg.dlc, msg.transmitter);
      const messageRowId = Number(msgInfo.lastInsertRowid);
      for (const sig of msg.signals) {
        const sigInfo = insSig.run(
          messageRowId,
          sig.name,
          sig.startBit,
          sig.length,
          sig.byteOrder,
          sig.valueType,
          sig.factor,
          sig.offset,
          sig.unit,
          sig.muxKind,
          sig.muxSwitchName ?? null,
          sig.muxValue ?? null
        );
        const signalRowId = Number(sigInfo.lastInsertRowid);
        for (const en of sig.enums) insEnum.run(signalRowId, en.value, en.name);
      }
    }
    return {
      id: versionId,
      versionNumber: meta.versionNumber,
      label: meta.label,
      validFrom: meta.validFrom,
      validTo: meta.validTo ?? null,
      sourceName: meta.sourceName,
      definitionHash: hash,
      importedAt: Date.now() / 1000,
    };
  });
}

export function listDbcVersions(handle: DbHandle): StoredDbcVersion[] {
  return handle.db
    .prepare('SELECT * FROM dbc_versions ORDER BY version_number')
    .all()
    .map(rowToVersion);
}

function rowToVersion(r: Record<string, unknown>): StoredDbcVersion {
  return {
    id: Number(r.id),
    versionNumber: Number(r.version_number),
    label: String(r.label),
    validFrom: Number(r.valid_from),
    validTo: r.valid_to === null ? null : Number(r.valid_to),
    sourceName: String(r.source_name),
    definitionHash: String(r.definition_hash),
    importedAt: Number(r.imported_at),
  };
}

export function resolveDbcForTime(handle: DbHandle, hwTime: number): StoredDbcVersion | undefined {
  const all = listDbcVersions(handle);
  const hit = resolveVersion(
    all.map((v) => ({ id: v.id, versionNumber: v.versionNumber, validFrom: v.validFrom, validTo: v.validTo })),
    hwTime
  );
  return hit ? all.find((v) => v.id === hit.id) : undefined;
}

export function loadDbcDocument(handle: DbHandle, versionId: number): DbcDocument {
  const version = handle.db.prepare('SELECT * FROM dbc_versions WHERE id = ?').get(versionId) as
    | Record<string, unknown>
    | undefined;
  if (!version) throw new Error(`DBC version ${versionId} not found`);
  return parseDbc(String(version.content), String(version.source_name));
}

export function storeTrace(handle: DbHandle, sourceName: string, frames: RawFrame[]): { importId: number; inserted: number } {
  const { db } = handle;
  return withTx(db, () => {
    const ordinalRow = db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM trace_imports').get() as { n: number };
    const info = db
      .prepare('INSERT INTO trace_imports (imported_at, source_name, frame_count, ordinal) VALUES (?, ?, ?, ?)')
      .run(Date.now() / 1000, sourceName, frames.length, ordinalRow.n);
    const importId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO frames (import_id, generation, channel, arbitration_id, is_extended, direction, hw_time, dlc, data, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    );
    let inserted = 0;
    for (const f of frames) {
      const contentHash = createHash('sha256')
        .update(JSON.stringify([f.generation, f.channel, f.id, f.isExtended ? 1 : 0, f.direction, f.hwTime, f.data]))
        .digest('hex')
        .slice(0, 16);
      const r = ins.run(
        importId,
        f.generation,
        f.channel,
        f.id,
        f.isExtended ? 1 : 0,
        f.direction,
        f.hwTime,
        f.dlc,
        Buffer.from(f.data),
        contentHash
      );
      inserted += Number(r.changes);
    }
    return { importId, inserted };
  });
}

export function loadMessageDefs(handle: DbHandle, versionId: number): MessageDef[] {
  const { db } = handle;
  const msgs = db
    .prepare('SELECT * FROM messages WHERE dbc_version_id = ? ORDER BY arbitration_id, is_extended')
    .all(versionId) as Record<string, unknown>[];
  return msgs.map((m): MessageDef => {
    const sigRows = db.prepare('SELECT * FROM signals WHERE message_id = ? ORDER BY id').all(Number(m.id)) as Record<string, unknown>[];
    const signals: SignalDef[] = sigRows.map((sr) => {
      const enums = (db.prepare('SELECT value, name FROM signal_enums WHERE signal_id = ? ORDER BY value').all(Number(sr.id)) as
        Record<string, unknown>[]).map((e) => ({ value: Number(e.value), name: String(e.name) }));
      return {
        name: String(sr.name),
        startBit: Number(sr.start_bit),
        length: Number(sr.length),
        byteOrder: String(sr.byte_order) as SignalDef['byteOrder'],
        valueType: String(sr.value_type) as SignalDef['valueType'],
        factor: Number(sr.factor),
        offset: Number(sr.offset),
        unit: String(sr.unit),
        muxKind: String(sr.mux_kind) as SignalDef['muxKind'],
        muxSwitchName: sr.mux_switch_name === null ? undefined : String(sr.mux_switch_name),
        muxValue: sr.mux_value === null ? undefined : Number(sr.mux_value),
        enums,
      };
    });
    return {
      messageId: Number(m.arbitration_id),
      isExtended: Number(m.is_extended) === 1,
      name: String(m.name),
      dlc: Number(m.dlc),
      transmitter: String(m.transmitter),
      signals,
    };
  });
}
