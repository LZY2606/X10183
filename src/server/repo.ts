import type { DatabaseSync } from "node:sqlite";
import { parseDbc } from "../core/dbc/parse";
import { rangesOverlap } from "../core/version";
import type {
  CrcRule,
  CounterRule,
  DbcVersion,
  IdKind,
  MessageDef,
  MuxRole,
  RawFrame,
  SignalDef,
} from "../core/types";

interface MessageRow {
  id: number;
  version_id: number;
  arb_id: number;
  kind: IdKind;
  name: string;
  dlc: number;
  transmitter: string;
}

export function insertFrames(db: DatabaseSync, frames: RawFrame[]): { inserted: number; skipped: number } {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO frames(channel, arb_id, kind, data, hw_time, gen, source, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.exec.bind(db, "BEGIN");
  tx();
  try {
    for (const f of frames) {
      const info = stmt.run(
        f.channel,
        f.arbId,
        f.kind,
        JSON.stringify(f.data),
        f.hwTime,
        f.gen,
        f.source,
        f.seq,
      );
      inserted += Number(info.changes);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { inserted, skipped: frames.length - inserted };
}

export function listFrames(db: DatabaseSync): RawFrame[] {
  const rows = db
    .prepare("SELECT * FROM frames ORDER BY gen, hw_time, id")
    .all() as Record<string, unknown>[];
  return rows.map(rowToFrame);
}

export function listFramesInsertOrder(db: DatabaseSync): RawFrame[] {
  const rows = db.prepare("SELECT * FROM frames ORDER BY id").all() as Record<string, unknown>[];
  return rows.map(rowToFrame);
}

function rowToFrame(r: Record<string, unknown>): RawFrame {
  return {
    id: Number(r.id),
    channel: String(r.channel),
    arbId: Number(r.arb_id),
    kind: String(r.kind) as IdKind,
    data: JSON.parse(String(r.data)) as number[],
    hwTime: Number(r.hw_time),
    gen: String(r.gen),
    source: String(r.source),
    seq: Number(r.seq),
  };
}

/** 规范化的重放顺序：与导入顺序无关。重复时间戳按 (channel, kind, arbId, data, id) 破平。 */
export function replayOrder(frames: RawFrame[]): RawFrame[] {
  return [...frames].sort((a, b) => {
    if (a.gen !== b.gen) return a.gen < b.gen ? -1 : 1;
    const ta = roundTime(a.hwTime);
    const tb = roundTime(b.hwTime);
    if (ta !== tb) return ta - tb;
    if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.arbId !== b.arbId) return a.arbId - b.arbId;
    const da = a.data.join(",");
    const db2 = b.data.join(",");
    if (da !== db2) return da < db2 ? -1 : 1;
    return a.id - b.id;
  });
}

function roundTime(t: number): number {
  // 保留到 1 纳秒文本精度即可；硬件时间通常是秒浮点。
  return Math.round(t * 1e9) / 1e9;
}

export function importDbcVersion(
  db: DatabaseSync,
  input: {
    name: string;
    sourceText: string;
    effectiveFrom: number;
    effectiveTo: number | null;
  },
): DbcVersion {
  const existing = db.prepare("SELECT * FROM dbc_versions").all() as Record<string, unknown>[];
  const collision = existing.find((r) => String(r.name) === input.name);
  if (collision) throw new Error(`DBC 版本名已存在：${input.name}`);

  const parsed = parseDbc(input.sourceText);

  // 同一 (arbId,kind) 不允许生效区间重叠——采集时点必须能唯一选定义。
  const keys = new Set(parsed.messages.map((m) => `${m.kind}:${m.arbId}`));
  for (const row of existing) {
    const prev = {
      effectiveFrom: Number(row.effective_from),
      effectiveTo: (row.effective_to as number | null) ?? null,
    };
    if (
      rangesOverlap(prev, {
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
      })
    ) {
      const prevMsgs = getMessages(db, Number(row.id));
      const overlapKey = prevMsgs.some((m) => keys.has(`${m.kind}:${m.arbId}`));
      if (overlapKey) {
        throw new Error(
          `生效区间与版本「${row.name}」重叠：共享相同 arbitration id 的消息布局无法在同一时点唯一确定`,
        );
      }
    }
  }

  db.exec("BEGIN");
  try {
    const info = db
      .prepare(
        "INSERT INTO dbc_versions(name, effective_from, effective_to, source_text, imported_at) VALUES (?,?,?,?,?)",
      )
      .run(input.name, input.effectiveFrom, input.effectiveTo, input.sourceText, Date.now());
    const versionId = Number(info.lastInsertRowid);

    const insMsg = db.prepare(
      "INSERT INTO messages(version_id, arb_id, kind, name, dlc, transmitter) VALUES (?,?,?,?,?,?)",
    );
    const insSig = db.prepare(
      `INSERT INTO signals(message_id, name, start_bit, length, byte_order, signed, scale, offset, unit, mux_type, mux_switch, mux_value)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insEnum = db.prepare("INSERT INTO enums(signal_id, raw_value, text) VALUES (?,?,?)");

    for (const msg of parsed.messages) {
      const mInfo = insMsg.run(
        versionId,
        msg.arbId,
        msg.kind,
        msg.name,
        msg.dlc,
        msg.transmitter,
      );
      const messageId = Number(mInfo.lastInsertRowid);
      for (const sig of msg.signals) {
        const sInfo = insSig.run(
          messageId,
          sig.name,
          sig.startBit,
          sig.length,
          sig.order,
          sig.signed ? 1 : 0,
          sig.scale,
          sig.offset,
          sig.unit,
          sig.mux.type,
          sig.mux.type === "case" ? sig.mux.switchName : null,
          sig.mux.type === "case" ? sig.mux.value : null,
        );
        const signalId = Number(sInfo.lastInsertRowid);
        for (const [raw, text] of Object.entries(sig.enums)) {
          insEnum.run(signalId, Number(raw), text);
        }
      }
    }
    db.exec("COMMIT");
    return getVersion(db, versionId)!;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 删除一个 DBC 修订（版本不可变，但调查场景允许整体撤回）；冻结快照不受影响。 */
export function deleteDbcVersion(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM dbc_versions WHERE id=?").run(id);
  resetCache(db);
}

export function listVersions(db: DatabaseSync): DbcVersion[] {
  const rows = db
    .prepare("SELECT * FROM dbc_versions ORDER BY effective_from, id")
    .all() as Record<string, unknown>[];
  return rows.map(rowToVersion);
}

export function getVersion(db: DatabaseSync, id: number): DbcVersion | null {
  const r = db.prepare("SELECT * FROM dbc_versions WHERE id=?").get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToVersion(r) : null;
}

function rowToVersion(r: Record<string, unknown>): DbcVersion {
  return {
    id: Number(r.id),
    name: String(r.name),
    effectiveFrom: Number(r.effective_from),
    effectiveTo: (r.effective_to as number | null) ?? null,
    sourceText: String(r.source_text),
    importedAt: Number(r.imported_at),
  };
}

const messageCache = new WeakMap<DatabaseSync, Map<number, MessageDef[]>>();

export function getMessages(db: DatabaseSync, versionId: number): MessageDef[] {
  let cache = messageCache.get(db);
  if (!cache) {
    cache = new Map();
    messageCache.set(db, cache);
  }
  const hit = cache.get(versionId);
  if (hit) return hit;

  const msgRows = db
    .prepare("SELECT * FROM messages WHERE version_id=? ORDER BY id")
    .all(versionId) as MessageRow[];
  const result: MessageDef[] = [];
  for (const m of msgRows) {
    const sigRows = db
      .prepare("SELECT * FROM signals WHERE message_id=? ORDER BY id")
      .all(m.id) as Record<string, unknown>[];
    const signals: SignalDef[] = sigRows.map((s) => {
      const enumRows = db
        .prepare("SELECT raw_value, text FROM enums WHERE signal_id=?")
        .all(Number(s.id)) as { raw_value: number; text: string }[];
      const enums: Record<number, string> = {};
      for (const e of enumRows) enums[Number(e.raw_value)] = e.text;
      let mux: MuxRole = { type: "plain" };
      if (s.mux_type === "switch") mux = { type: "switch" };
      if (s.mux_type === "case")
        mux = {
          type: "case",
          switchName: String(s.mux_switch),
          value: Number(s.mux_value),
        };
      return {
        name: String(s.name),
        startBit: Number(s.start_bit),
        length: Number(s.length),
        order: String(s.byte_order) as SignalDef["order"],
        signed: Number(s.signed) === 1,
        scale: Number(s.scale),
        offset: Number(s.offset),
        unit: String(s.unit ?? ""),
        mux,
        enums,
      };
    });
    result.push({
      arbId: m.arb_id,
      kind: m.kind,
      name: m.name,
      dlc: m.dlc,
      transmitter: m.transmitter,
      signals,
    });
  }
  cache.set(versionId, result);
  return result;
}

export function listAllMessages(db: DatabaseSync): { version: DbcVersion; messages: MessageDef[] }[] {
  return listVersions(db).map((v) => ({ version: v, messages: getMessages(db, v.id) }));
}

export function resetCache(db: DatabaseSync) {
  messageCache.delete(db);
}

// ---- 规则配置 ----

export function upsertCrcRule(db: DatabaseSync, rule: CrcRule): void {
  db.prepare(
    `INSERT INTO crc_rules(message_name, cover_signals, crc_signal, poly, init, xor_out)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(message_name) DO UPDATE SET
       cover_signals=excluded.cover_signals,
       crc_signal=excluded.crc_signal,
       poly=excluded.poly, init=excluded.init, xor_out=excluded.xor_out`,
  ).run(
    rule.messageName,
    rule.coverSignals === null ? null : JSON.stringify(rule.coverSignals),
    rule.crcSignal,
    rule.poly,
    rule.init,
    rule.xorOut,
  );
}

export function listCrcRules(db: DatabaseSync): CrcRule[] {
  const rows = db.prepare("SELECT * FROM crc_rules").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    messageName: String(r.message_name),
    coverSignals: r.cover_signals === null ? null : (JSON.parse(String(r.cover_signals)) as string[]),
    crcSignal: String(r.crc_signal),
    poly: Number(r.poly),
    init: Number(r.init),
    xorOut: Number(r.xor_out),
  }));
}

export function upsertCounterRule(db: DatabaseSync, rule: CounterRule): void {
  db.prepare(
    `INSERT INTO counter_rules(message_name, signal_name, width) VALUES (?,?,?)
     ON CONFLICT(message_name) DO UPDATE SET signal_name=excluded.signal_name, width=excluded.width`,
  ).run(rule.messageName, rule.signalName, rule.width);
}

export function listCounterRules(db: DatabaseSync): CounterRule[] {
  const rows = db.prepare("SELECT * FROM counter_rules").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    messageName: String(r.message_name),
    signalName: String(r.signal_name),
    width: Number(r.width),
  }));
}
