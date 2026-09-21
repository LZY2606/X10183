import type { DatabaseSync } from "node:sqlite";
import type {
  CounterReport,
  CounterRule,
  CrcEvidence,
  CrcRule,
  DbcVersion,
  DecodeResult,
  MessageDef,
  MigrationMapping,
  RawFrame,
  Snapshot
} from "../core/types.js";
import { parseDbc, selectDbcVersion } from "../core/dbc.js";
import { parseTrace, deterministicOrder } from "../core/trace.js";
import { decodeFrame } from "../core/decode.js";
import { checkCounters, type CounterInput } from "../core/counter.js";
import { verifyCrc } from "../core/crc.js";
import {
  compareMessages,
  defaultSignalMappings,
  messageKey
} from "../core/migration.js";
import {
  loadAllFrames,
  loadBatches,
  loadCrcRules,
  loadCounterRules,
  loadDbcVersions,
  loadMessageDefs,
  loadMappings,
  loadSnapshots
} from "./db.js";

export interface FrameView {
  frame: RawFrame;
  generation: string;
  importLabel: string;
}

export function allFrameViews(db: DatabaseSync): FrameView[] {
  const batches = new Map(loadBatches(db).map((b) => [b.id, b]));
  const frames = loadAllFrames(db);
  const ordered = deterministicOrder(frames) as RawFrame[];
  return ordered.map((frame) => ({
    frame,
    generation: batches.get(frame.importId)?.generation ?? "gen-unknown",
    importLabel: batches.get(frame.importId)?.label ?? "未知导入"
  }));
}

export function importTrace(
  db: DatabaseSync,
  text: string,
  opts: { label: string; generation: string }
): { batchId: number; frameCount: number } {
  const parsed = parseTrace(text);
  const info = db
    .prepare(
      "INSERT INTO import_batch(label, generation, imported_at, frame_count) VALUES (?,?,?,?)"
    )
    .run(opts.label, opts.generation, new Date().toISOString(), parsed.length);
  const batchId = Number(info.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO raw_frame(import_id, channel, arbitration_id, extended, hw_time_ns, dlc, data, seq_in_import)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  parsed.forEach((f, idx) => {
    insert.run(
      batchId,
      f.channel,
      f.arbitrationId,
      f.extended ? 1 : 0,
      f.hwTimeNs,
      f.data.length,
      Buffer.from(f.data),
      idx
    );
  });
  return { batchId, frameCount: parsed.length };
}

/** 插入 DBC 版本；versionNumber 冲突由 UNIQUE 约束报错。 */
export function importDbc(
  db: DatabaseSync,
  text: string,
  opts: { name?: string; versionNumber?: number; effectiveFromNs?: string | null; effectiveToNs?: string | null } = {}
): DbcVersion {
  const parsed = parseDbc(text);
  const versionNumber =
    opts.versionNumber ??
    parsed.versionNumber ??
    (Number(
      (
        db.prepare("SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM dbc_version").get() as {
          v: number;
        }
      ).v
    ));
  const name = opts.name ?? parsed.name ?? `DBC v${versionNumber}`;
  const fromNs =
    opts.effectiveFromNs === undefined
      ? parsed.effectiveFromNs
      : opts.effectiveFromNs === null
        ? null
        : BigInt(opts.effectiveFromNs);
  const toNs =
    opts.effectiveToNs === undefined
      ? parsed.effectiveToNs
      : opts.effectiveToNs === null
        ? null
        : BigInt(opts.effectiveToNs);

  const info = db
    .prepare(
      `INSERT INTO dbc_version(name, version_number, effective_from_ns, effective_to_ns, source_text, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(name, versionNumber, fromNs, toNs, text, new Date().toISOString());
  const versionId = Number(info.lastInsertRowid);

  // 消息与信号
  const insMsg = db.prepare(
    `INSERT INTO message_def(dbc_version_id, name, arbitration_id, extended, channel, dlc, transmitter)
     VALUES (?,?,?,?,?,?,?)`
  );
  const insSig = db.prepare(
    `INSERT INTO signal_def(message_def_id, name, start_bit, length, byte_order, signed, scale, offset,
       minimum, maximum, unit, mux_kind, mux_value, mux_switch_name, mux_ranges, enums)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const m of parsed.messages) {
    const mi = insMsg.run(
      versionId,
      m.name,
      m.arbitrationId,
      m.extended ? 1 : 0,
      m.channel,
      m.dlc,
      m.transmitter
    );
    const messageId = Number(mi.lastInsertRowid);
    for (const s of m.signals) {
      insSig.run(
        messageId,
        s.name,
        s.startBit,
        s.length,
        s.byteOrder,
        s.signed ? 1 : 0,
        s.scale,
        s.offset,
        s.minimum,
        s.maximum,
        s.unit,
        s.muxKind,
        s.muxValue,
        s.muxSwitchName,
        s.muxRanges ? JSON.stringify(s.muxRanges) : null,
        s.enums ? JSON.stringify(s.enums) : null
      );
    }
  }
  return {
    id: versionId,
    name,
    versionNumber,
    effectiveFromNs: fromNs === null ? null : fromNs.toString(),
    effectiveToNs: toNs === null ? null : toNs.toString(),
    sourceText: text
  };
}

/** 为帧挑选匹配消息定义：同一 arb id 区分标准/扩展，通道 null 视为通配。 */
export function findMessage(
  defs: MessageDef[],
  frame: RawFrame
): MessageDef | null {
  const exact = defs.find(
    (m) =>
      m.arbitrationId === frame.arbitrationId &&
      m.extended === frame.extended &&
      (m.channel === null || m.channel === frame.channel)
  );
  return exact ?? null;
}

/**
 * 用指定版本（或按帧时间自动选生效版本）解码整库。
 * 返回每帧的：选中版本、命中消息、解码值、是否“过期”（帧时间不属于该版本生效区间）。
 */
export function decodeWithVersion(
  db: DatabaseSync,
  forcedVersionId: number | null
): Array<{
  view: FrameView;
  version: DbcVersion | null;
  message: MessageDef | null;
  decode: DecodeResult;
  stale: boolean;
  staleReason: string | null;
}> {
  const versions = loadDbcVersions(db);
  const views = allFrameViews(db);
  const defsCache = new Map<number, MessageDef[]>();
  const getDefs = (id: number) => {
    let defs = defsCache.get(id);
    if (!defs) {
      defs = loadMessageDefs(db, id);
      defsCache.set(id, defs);
    }
    return defs;
  };

  return views.map((view) => {
    const t = BigInt(view.frame.hwTimeNs);
    let version: DbcVersion | null;
    let stale = false;
    let staleReason: string | null = null;
    if (forcedVersionId !== null) {
      version = versions.find((v) => v.id === forcedVersionId) ?? null;
      if (version) {
        const from = version.effectiveFromNs === null ? null : BigInt(version.effectiveFromNs);
        const to = version.effectiveToNs === null ? null : BigInt(version.effectiveToNs);
        if ((from !== null && t < from) || (to !== null && t >= to)) {
          stale = true;
          staleReason = "帧采集时间不在该 DBC 版本生效区间内";
        }
      }
    } else {
      version = selectDbcVersion(versions, t);
    }
    const message = version ? findMessage(getDefs(version.id), view.frame) : null;
    const decode = decodeFrame(view.frame, message);
    return { view, version, message, decode, stale, staleReason };
  });
}

export function counterAnalysis(db: DatabaseSync): CounterReport[] {
  const rules = loadCounterRules(db);
  const decoded = decodeWithVersion(db, null);
  const inputs: CounterInput[] = decoded.map((d) => ({
    frame: d.view.frame,
    message: d.message,
    decode: d.decode,
    generation: d.view.generation
  }));
  return checkCounters(inputs, rules);
}

export function crcAnalysis(db: DatabaseSync): CrcEvidence[] {
  const rules = loadCrcRules(db);
  const decoded = decodeWithVersion(db, null);
  const out: CrcEvidence[] = [];
  for (const d of decoded) {
    for (const rule of rules) {
      if (
        rule.arbitrationId !== d.view.frame.arbitrationId ||
        rule.extended !== d.view.frame.extended
      )
        continue;
      if (rule.channel !== null && rule.channel !== d.view.frame.channel) continue;
      if (!d.message) {
        out.push({
          frameId: d.view.frame.id,
          hwTimeNs: d.view.frame.hwTimeNs,
          rule,
          verdict: "unchecked",
          expected: null,
          actual: null,
          coveredBytes: null,
          crcByte: null,
          reason: "帧时间点无生效 DBC / 无消息定义，未核验"
        });
        continue;
      }
      out.push(verifyCrc(d.view.frame, rule, d.message));
    }
  }
  return out;
}

/** 计算两个版本的比对结果（不落库）。 */
export function compareVersions(db: DatabaseSync, fromId: number, toId: number) {
  const from = loadMessageDefs(db, fromId);
  const to = loadMessageDefs(db, toId);
  return compareMessages(from, to);
}

export function proposeMappings(
  db: DatabaseSync,
  fromId: number,
  toId: number
): MigrationMapping[] {
  const cmps = compareVersions(db, fromId, toId);
  const existing = new Set(
    loadMappings(db)
      .filter((m) => m.fromVersionId === fromId && m.toVersionId === toId)
      .map((m) => m.messageDefKey)
  );
  const insert = db.prepare(
    `INSERT INTO migration_mapping(from_version_id, to_version_id, message_def_key,
       from_message_name, to_message_name, signal_mappings, status, note, lock_version)
     VALUES (?,?,?,?,?,?, 'proposed', NULL, 1)`
  );
  const created: MigrationMapping[] = [];
  for (const cmp of cmps) {
    if (existing.has(cmp.key)) continue;
    const mappings = defaultSignalMappings(cmp);
    const info = insert.run(
      fromId,
      toId,
      cmp.key,
      cmp.fromMessageName,
      cmp.toMessageName,
      JSON.stringify(mappings)
    );
    created.push({
      id: Number(info.lastInsertRowid),
      fromVersionId: fromId,
      toVersionId: toId,
      messageDefKey: cmp.key,
      fromMessageName: cmp.fromMessageName,
      toMessageName: cmp.toMessageName,
      signalMappings: JSON.stringify(mappings),
      status: "proposed",
      note: null,
      lockVersion: 1
    });
  }
  return created;
}

export class OptimisticLockError extends Error {
  constructor(public currentLock: number) {
    super(`映射已被其他审批修改：当前版本号 ${currentLock}`);
    this.name = "OptimisticLockError";
  }
}

/**
 * 审批迁移映射。expectedLock 必须等于库内 lock_version，否则视为并发冲突。
 * 批准 "approved" 要求映射中不存在 removed 信号；否则只能标记 incompatible。
 */
export function approveMapping(
  db: DatabaseSync,
  mappingId: number,
  expectedLock: number,
  decision: "approved" | "incompatible",
  note: string | null
): MigrationMapping {
  const row = db.prepare("SELECT * FROM migration_mapping WHERE id = ?").get(mappingId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error("映射不存在");
  const currentLock = row.lock_version as number;
  if (currentLock !== expectedLock) {
    throw new OptimisticLockError(currentLock);
  }
  if (decision === "approved") {
    const parsed = JSON.parse(row.signal_mappings as string) as Record<
      string,
      { kind: string }
    >;
    const removed = Object.values(parsed).filter((v) => v.kind === "removed");
    if (removed.length > 0) {
      throw new Error(`无法批准：存在 ${removed.length} 个被移除信号的映射，应标记为不兼容`);
    }
  }
  db.prepare(
    "UPDATE migration_mapping SET status = ?, note = ?, lock_version = lock_version + 1 WHERE id = ?"
  ).run(decision, note, mappingId);
  const updated = db.prepare("SELECT * FROM migration_mapping WHERE id = ?").get(mappingId) as Record<
    string,
    unknown
  >;
  return {
    id: updated.id as number,
    fromVersionId: updated.from_version_id as number,
    toVersionId: updated.to_version_id as number,
    messageDefKey: updated.message_def_key as string,
    fromMessageName: updated.from_message_name as string,
    toMessageName: (updated.to_message_name as string | null) ?? null,
    signalMappings: updated.signal_mappings as string,
    status: updated.status as MigrationMapping["status"],
    note: (updated.note as string | null) ?? null,
    lockVersion: updated.lock_version as number
  };
}

/** 创建冻结调查快照：固定 DBC 版本与当时解码结果，后续修订不影响其内容。 */
export function createSnapshot(
  db: DatabaseSync,
  label: string,
  pinnedVersionId: number,
  frameIds?: number[]
): Snapshot {
  const decoded = decodeWithVersion(db, pinnedVersionId);
  const selected = frameIds
    ? decoded.filter((d) => frameIds.includes(d.view.frame.id))
    : decoded;
  const payload = selected.map((d) => ({
    frame: {
      id: d.view.frame.id,
      channel: d.view.frame.channel,
      arbitrationId: d.view.frame.arbitrationId,
      extended: d.view.frame.extended,
      hwTimeNs: d.view.frame.hwTimeNs,
      dataHex: d.view.frame.data.toString("hex"),
      generation: d.view.generation
    },
    versionId: pinnedVersionId,
    messageName: d.message?.name ?? null,
    signals: d.decode.signals,
    muxBranches: d.decode.muxBranches
  }));
  const info = db
    .prepare(
      "INSERT INTO snapshot(label, created_at, pinned_dbc_version_id, payload_json) VALUES (?,?,?,?)"
    )
    .run(label, new Date().toISOString(), pinnedVersionId, JSON.stringify(payload));
  return {
    id: Number(info.lastInsertRowid),
    label,
    createdAt: new Date().toISOString(),
    pinnedDbcVersionId: pinnedVersionId,
    payloadJson: JSON.stringify(payload)
  };
}

export function listSnapshots(db: DatabaseSync): Snapshot[] {
  return loadSnapshots(db);
}

export { messageKey };
