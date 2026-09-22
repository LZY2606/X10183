import type { DB } from './db.js';
import type { RuleChecksum, RuleCounter } from '../src/types.js';
import { parseDbc, type ParsedDbc } from './dbc.js';
import { listDbcVersions, loadDbcVersion } from './repo.js';

export interface CreateDbcInput {
  label: string;
  source?: string;
  effectiveFrom?: number | null;
  effectiveTo?: number | null;
  parsed?: ParsedDbc;
  counters?: RuleCounter[];
  checksums?: RuleChecksum[];
}

export function createDbcVersion(db: DB, input: CreateDbcInput) {
  if (!input.label?.trim()) throw new Error('版本标签不能为空');
  const source = input.source ?? '';
  const parsed = input.parsed ?? parseDbc(source);
  validateInterval(input.effectiveFrom ?? null, input.effectiveTo ?? null);

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO dbc_versions (label, source, effective_from, effective_to)
         VALUES (?, ?, ?, ?)`
      )
      .run(input.label, source, input.effectiveFrom ?? null, input.effectiveTo ?? null);
    const dbcId = Number(info.lastInsertRowid);
    insertParsed(db, dbcId, parsed);
    for (const c of input.counters ?? []) insertCounterRule(db, dbcId, parsed, c);
    for (const c of input.checksums ?? []) insertChecksumRule(db, dbcId, c);
    return dbcId;
  });
  return tx();
}

function validateInterval(from: number | null, to: number | null) {
  if (from !== null && to !== null && !(from < to)) {
    throw new Error('生效区间必须满足 from < to（区间为 [from, to)）');
  }
}

function insertParsed(db: DB, dbcId: number, parsed: ParsedDbc) {
  for (const msg of parsed.messages) {
    const info = db
      .prepare(
        `INSERT INTO message_defs (dbc_id, arb_id, extended, name, dlc, transmitter)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(dbcId, msg.arbId, msg.extended ? 1 : 0, msg.name, msg.dlc, msg.transmitter);
    const msgId = Number(info.lastInsertRowid);
    for (const sig of msg.signals) {
      const s = db
        .prepare(
          `INSERT INTO signal_defs
           (message_def_id, name, start_bit, length, byte_order, signed, scale, offset, unit, mux_type, mux_switch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          msgId,
          sig.name,
          sig.startBit,
          sig.length,
          sig.byteOrder,
          sig.signed ? 1 : 0,
          sig.scale,
          sig.offset,
          sig.unit,
          sig.muxType,
          sig.muxSwitch
        );
      const sigId = Number(s.lastInsertRowid);
      for (const e of sig.enums) {
        db.prepare('INSERT INTO value_descs (signal_def_id, raw, label) VALUES (?, ?, ?)').run(sigId, e.raw, e.label);
      }
    }
  }
}

function insertCounterRule(db: DB, dbcId: number, parsed: ParsedDbc, c: RuleCounter) {
  const msg = parsed.messages.find((m) => m.signals.some((s) => s.name === c.signalName));
  db.prepare(
    `INSERT INTO rule_counters (dbc_id, arb_id, extended, signal_name, width, node)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(dbcId, msg?.arbId ?? 0, msg?.extended ? 1 : 0, c.signalName, c.width, c.node);
}

function insertChecksumRule(db: DB, dbcId: number, c: RuleChecksum) {
  const found = db
    .prepare(
      `SELECT m.arb_id AS arb_id, m.extended AS extended
       FROM message_defs m JOIN signal_defs s ON s.message_def_id = m.id
       WHERE m.dbc_id = ? AND s.name = ?
       ORDER BY m.id LIMIT 1`
    )
    .get(dbcId, c.signalName) as { arb_id: number; extended: number } | undefined;
  db.prepare(
    `INSERT INTO rule_checksums
     (dbc_id, arb_id, extended, signal_name, algorithm, start_byte, end_byte, init, xor_in, xor_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dbcId,
    found?.arb_id ?? 0,
    found?.extended ?? 0,
    c.signalName,
    c.algorithm || 'crc8',
    c.startByte,
    c.endByte,
    c.init,
    c.xorIn,
    c.xorOut
  );
}

export interface IntervalUpdate {
  effectiveFrom?: number | null;
  effectiveTo?: number | null;
  expectedVersion?: number;
}

// 修订生效区间；仅落在受影响时间窗内的解码缓存标记过期
export function updateEffectiveInterval(db: DB, dbcId: number, upd: IntervalUpdate) {
  const current = loadDbcVersion(db, dbcId);
  if (!current) throw new Error('DBC 版本不存在');
  const vRow = db.prepare('SELECT version FROM dbc_versions WHERE id = ?').get(dbcId) as { version: number };
  if (upd.expectedVersion !== undefined && upd.expectedVersion !== vRow.version) {
    const err = new Error('版本冲突：DBC 定义已被他人修改');
    (err as Error & { code?: string }).code = 'VERSION_CONFLICT';
    throw err;
  }
  const from = upd.effectiveFrom === undefined ? current.effectiveFrom : upd.effectiveFrom;
  const to = upd.effectiveTo === undefined ? current.effectiveTo : upd.effectiveTo;
  validateInterval(from, to);

  const tx = db.transaction(() => {
    db.prepare('UPDATE dbc_versions SET effective_from = ?, effective_to = ?, version = version + 1 WHERE id = ?').run(
      from,
      to,
      dbcId
    );
    // 精确失效：逐帧比较“缓存解析的版本”与“新规则下解析的版本”，仅变化的帧标记过期
    const inNew = (t: number) => (from === null || from <= t) && (to === null || t < to);
    const inOld = (t: number) =>
      (current.effectiveFrom === null || current.effectiveFrom <= t) &&
      (current.effectiveTo === null || t < current.effectiveTo);
    const frames = db.prepare('SELECT id, hw_time FROM frames').all() as { id: number; hw_time: number }[];
    const staleIds = frames
      .filter((f) => inOld(f.hw_time) !== inNew(f.hw_time))
      .map((f) => f.id);
    if (staleIds.length) {
      const placeholders = staleIds.map(() => '?').join(',');
      db.prepare(`UPDATE decode_cache SET stale = 1 WHERE frame_id IN (${placeholders})`).run(...staleIds);
    }
    return listDbcVersions(db).find((v) => v.id === dbcId)!;
  });
  return tx();
}

export function getRules(db: DB, dbcId: number) {
  const counters = db.prepare('SELECT * FROM rule_counters WHERE dbc_id = ? ORDER BY id').all(dbcId) as Record<string, unknown>[];
  const checksums = db.prepare('SELECT * FROM rule_checksums WHERE dbc_id = ? ORDER BY id').all(dbcId) as Record<string, unknown>[];
  return { counters: counters.map(mapCounter), checksums: checksums.map(mapChecksum) };
}

function mapCounter(r: Record<string, unknown>): RuleCounter & { arbId: number; extended: boolean } {
  return {
    arbId: r.arb_id as number,
    extended: !!r.extended,
    signalName: r.signal_name as string,
    width: r.width as number,
    node: r.node as string
  };
}

function mapChecksum(r: Record<string, unknown>): RuleChecksum & { arbId: number; extended: boolean } {
  return {
    arbId: r.arb_id as number,
    extended: !!r.extended,
    signalName: r.signal_name as string,
    algorithm: r.algorithm as string,
    startByte: r.start_byte as number | null,
    endByte: r.end_byte as number | null,
    init: r.init as number | null,
    xorIn: r.xor_in as number | null,
    xorOut: r.xor_out as number | null
  };
}
