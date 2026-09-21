import type { DatabaseSync } from "node:sqlite";
import { getMessages, getVersion } from "../server/repo";
import type {
  MessageDef,
  MigrationMapping,
  MigrationRecord,
  SignalDef,
} from "./types";

export interface VersionDiff {
  messageName: string;
  arbId: number;
  kind: "std" | "ext";
  status: "added" | "removed" | "compatible" | "changed" | "incompatible";
  mappings: MigrationMapping[];
  summary: string;
}

function sameBitLayout(a: SignalDef, b: SignalDef): boolean {
  return (
    a.startBit === b.startBit &&
    a.length === b.length &&
    a.order === b.order &&
    a.signed === b.signed
  );
}

function sameSemantics(a: SignalDef, b: SignalDef): boolean {
  return (
    sameBitLayout(a, b) &&
    a.scale === b.scale &&
    a.offset === b.offset &&
    a.unit === b.unit &&
    JSON.stringify(a.enums) === JSON.stringify(b.enums) &&
    JSON.stringify(a.mux) === JSON.stringify(b.mux)
  );
}

/** 比较两个 DBC 版本中相同 arbitration id 的消息，给出逐信号迁移映射。 */
export function diffVersions(
  db: DatabaseSync,
  fromVersionId: number,
  toVersionId: number,
): { from: string; to: string; diffs: VersionDiff[]; error?: string } {
  const from = getVersion(db, fromVersionId);
  const to = getVersion(db, toVersionId);
  if (!from || !to) return { from: "", to: "", diffs: [], error: "DBC 版本不存在" };

  const fromMsgs = getMessages(db, fromVersionId);
  const toMsgs = getMessages(db, toVersionId);
  const key = (m: MessageDef) => `${m.kind}:${m.arbId}`;
  const toByKey = new Map(toMsgs.map((m) => [key(m), m]));
  const fromByKey = new Map(fromMsgs.map((m) => [key(m), m]));

  const diffs: VersionDiff[] = [];

  for (const oldMsg of fromMsgs) {
    const newMsg = toByKey.get(key(oldMsg));
    if (!newMsg) {
      diffs.push({
        messageName: oldMsg.name,
        arbId: oldMsg.arbId,
        kind: oldMsg.kind,
        status: "removed",
        mappings: [],
        summary: `消息 ${oldMsg.name} 在新版本中删除`,
      });
      continue;
    }
    const mappings = mapSignals(oldMsg, newMsg, fromVersionId, toVersionId);
    const incompatibleCount = mappings.filter((m) => m.classification === "incompatible").length;
    const identicalCount = mappings.filter((m) => m.classification === "identical").length;
    const status: VersionDiff["status"] =
      mappings.length === identicalCount
        ? "compatible"
        : incompatibleCount > 0
          ? "incompatible"
          : "changed";
    diffs.push({
      messageName: oldMsg.name,
      arbId: oldMsg.arbId,
      kind: oldMsg.kind,
      status,
      mappings,
      summary:
        status === "compatible"
          ? "所有信号布局与语义一致"
          : `${identicalCount} 一致 / ${mappings.length - identicalCount - incompatibleCount} 可适配 / ${incompatibleCount} 不兼容`,
    });
  }

  for (const newMsg of toMsgs) {
    if (!fromByKey.has(key(newMsg))) {
      diffs.push({
        messageName: newMsg.name,
        arbId: newMsg.arbId,
        kind: newMsg.kind,
        status: "added",
        mappings: [],
        summary: `消息 ${newMsg.name} 为新版本新增`,
      });
    }
  }

  diffs.sort((a, b) => a.arbId - b.arbId || a.kind.localeCompare(b.kind));
  return { from: from.name, to: to.name, diffs };
}

function mapSignals(
  oldMsg: MessageDef,
  newMsg: MessageDef,
  fromVersionId: number,
  toVersionId: number,
): MigrationMapping[] {
  const newByName = new Map(newMsg.signals.map((s) => [s.name, s]));
  const usedNames = new Set<string>();
  const mappings: MigrationMapping[] = [];

  for (const oldSig of oldMsg.signals) {
    const newSig = newByName.get(oldSig.name);
    usedNames.add(oldSig.name);
    if (!newSig) {
      mappings.push({
        signalName: oldSig.name,
        fromVersionId,
        toVersionId,
        oldSignal: oldSig.name,
        newSignal: null,
        classification: "incompatible",
        note: "新版本中信号已删除，无法兼容",
      });
      continue;
    }
    if (sameSemantics(oldSig, newSig)) {
      mappings.push({
        signalName: oldSig.name,
        fromVersionId,
        toVersionId,
        oldSignal: oldSig.name,
        newSignal: newSig.name,
        classification: "identical",
        note: "位区间/字节序/缩放/偏置/枚举/多路复用均一致",
      });
    } else if (sameBitLayout(oldSig, newSig)) {
      const changed: string[] = [];
      if (oldSig.scale !== newSig.scale) changed.push(`缩放 ${oldSig.scale}→${newSig.scale}`);
      if (oldSig.offset !== newSig.offset) changed.push(`偏置 ${oldSig.offset}→${newSig.offset}`);
      if (oldSig.unit !== newSig.unit) changed.push(`单位 ${oldSig.unit}→${newSig.unit}`);
      if (JSON.stringify(oldSig.enums) !== JSON.stringify(newSig.enums)) changed.push("枚举表");
      mappings.push({
        signalName: oldSig.name,
        fromVersionId,
        toVersionId,
        oldSignal: oldSig.name,
        newSignal: newSig.name,
        classification: "adapted",
        note: `位布局不变，${changed.join("、") || "语义"}调整，按新定义重算物理值`,
      });
    } else {
      mappings.push({
        signalName: oldSig.name,
        fromVersionId,
        toVersionId,
        oldSignal: oldSig.name,
        newSignal: newSig.name,
        classification: "incompatible",
        note: `位布局改变（start ${oldSig.startBit}|${oldSig.length}@${oldSig.order} → ${newSig.startBit}|${newSig.length}@${newSig.order}），历史 raw 无法安全迁移`,
      });
    }
  }

  for (const newSig of newMsg.signals) {
    if (!usedNames.has(newSig.name)) {
      mappings.push({
        signalName: newSig.name,
        fromVersionId,
        toVersionId,
        oldSignal: null,
        newSignal: newSig.name,
        classification: "adapted",
        note: "新增信号，迁移时以默认值填充",
      });
    }
  }
  return mappings;
}

// ---- 持久化的迁移审批（乐观锁） ----

interface MigrationRow {
  id: number;
  message_name: string;
  from_version_id: number;
  to_version_id: number;
  status: MigrationRecord["status"];
  lock_version: number;
  payload: string;
  summary: string;
  created_at: number;
  updated_at: number;
}

export function ensureMigrations(
  db: DatabaseSync,
  fromVersionId: number,
  toVersionId: number,
): MigrationRecord[] {
  const { diffs } = diffVersions(db, fromVersionId, toVersionId);
  const now = Date.now();
  const out: MigrationRecord[] = [];
  for (const d of diffs) {
    if (d.status === "added" || d.status === "removed") continue;
    const existing = db
      .prepare(
        "SELECT * FROM migrations WHERE message_name=? AND from_version_id=? AND to_version_id=?",
      )
      .get(d.messageName, fromVersionId, toVersionId) as MigrationRow | undefined;
    if (existing) {
      out.push(rowToMigration(existing));
      continue;
    }
    const info = db
      .prepare(
        `INSERT INTO migrations(message_name, from_version_id, to_version_id, status, lock_version, payload, summary, created_at, updated_at)
         VALUES (?,?,?,'pending',1,?,?,?,?)`,
      )
      .run(
        d.messageName,
        fromVersionId,
        toVersionId,
        JSON.stringify(d.mappings),
        d.summary,
        now,
        now,
      );
    const row = db.prepare("SELECT * FROM migrations WHERE id=?").get(Number(info.lastInsertRowid)) as MigrationRow;
    out.push(rowToMigration(row));
  }
  return out;
}

export function listMigrations(db: DatabaseSync): MigrationRecord[] {
  const rows = db.prepare("SELECT * FROM migrations ORDER BY id").all() as MigrationRow[];
  return rows.map(rowToMigration);
}

/**
 * 审批：乐观并发。expectedLock 必须与当前 lock_version 一致；
 * 两个并发审批只有一个成功，另一个得到 VersionConflictError。
 */
export class VersionConflictError extends Error {
  current: number;
  constructor(current: number) {
    super(`迁移记录已被其他审批修改：期望版本号不匹配，当前 lock_version=${current}`);
    this.name = "VersionConflictError";
    this.current = current;
  }
}

export function decideMigration(
  db: DatabaseSync,
  id: number,
  decision: "approved" | "rejected",
  expectedLock: number,
): MigrationRecord {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM migrations WHERE id=?").get(id) as MigrationRow | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      throw new Error("迁移记录不存在");
    }
    if (row.lock_version !== expectedLock) {
      db.exec("ROLLBACK");
      throw new VersionConflictError(row.lock_version);
    }
    db.prepare(
      "UPDATE migrations SET status=?, lock_version=lock_version+1, updated_at=? WHERE id=?",
    ).run(decision, Date.now(), id);
    db.exec("COMMIT");
    const updated = db.prepare("SELECT * FROM migrations WHERE id=?").get(id) as MigrationRow;
    return rowToMigration(updated);
  } catch (e) {
    if ((e as Error).message !== "迁移记录不存在" && !(e instanceof VersionConflictError)) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore
      }
    }
    throw e;
  }
}

function rowToMigration(r: MigrationRow): MigrationRecord {
  return {
    id: r.id,
    messageName: r.message_name,
    fromVersionId: r.from_version_id,
    toVersionId: r.to_version_id,
    status: r.status,
    lockVersion: r.lock_version,
    mappings: JSON.parse(r.payload) as MigrationMapping[],
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
