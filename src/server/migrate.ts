// 总线刻度 — 两个 DBC 版本对比、迁移映射审批（基于版本号的并发冲突）
import type Database from 'better-sqlite3';
import type {
  MessageDef, MigrationMapping, VersionCompare, VersionCompareEntry
} from '../shared/types.js';
import { rowToVersion, getAllMessagesByVersion } from './repo.js';
import { getVersion } from './versions.js';

export class MigrationError extends Error {}

interface SigSig {
  name: string;
  startBit: number;
  length: number;
  byteOrder: number;
  signed: boolean;
  factor: number;
  offset: number;
  muxType: string | null;
  muxValue: number | null;
  role: string | null;
}

const sigKey = (s: SigSig) =>
  [s.name, s.startBit, s.length, s.byteOrder, s.signed ? 1 : 0, s.factor, s.offset,
   s.muxType ?? '', s.muxValue ?? '', s.role ?? ''].join('|');

function classify(a: MessageDef | undefined, b: MessageDef | undefined): VersionCompareEntry {
  const id = a ? { arbId: a.arbId, idKind: a.idKind } : { arbId: b!.arbId, idKind: b!.idKind };
  if (a && !b) {
    return {
      ...id,
      messageNameA: a.name,
      messageNameB: null,
      relation: 'removed',
      reason: '新版本删除了该消息定义'
    };
  }
  if (!a && b) {
    return {
      ...id,
      messageNameA: null,
      messageNameB: b.name,
      relation: 'added',
      reason: '新版本新增了该消息定义'
    };
  }
  if (a && b) {
    if (a.length !== b.length || a.sender !== b.sender) {
      return {
        ...id,
        messageNameA: a.name,
        messageNameB: b.name,
        relation: 'incompatible',
        reason: `DLC/发送节点改变（${a.length}/${a.sender || '-'} -> ${b.length}/${b.sender || '-'}）`
      };
    }
    const aSig = [...a.signals].sort((x, y) => x.name.localeCompare(y.name));
    const bSig = [...b.signals].sort((x, y) => x.name.localeCompare(y.name));
    const aKeys = new Set(aSig.map(sigKey));
    const bKeys = new Set(bSig.map(sigKey));
    const sameCount = aSig.filter((s) => bKeys.has(sigKey(s))).length;
    const onlyA = aSig.filter((s) => !bKeys.has(sigKey(s))).map((s) => s.name);
    const onlyB = bSig.filter((s) => !aKeys.has(sigKey(s))).map((s) => s.name);

    if (aSig.length === bSig.length && sameCount === aSig.length) {
      return {
        ...id,
        messageNameA: a.name,
        messageNameB: b.name,
        relation: 'unchanged',
        reason: '信号布局、缩放、偏置、枚举与多路复用完全一致'
      };
    }
    // 若发生字节序/位区间/有符号性变化的同名信号 => 无法兼容
    const hardBreak = aSig.some((sa) => {
      const sb = bSig.find((x) => x.name === sa.name);
      return sb && (
        sa.startBit !== sb.startBit ||
        sa.length !== sb.length ||
        sa.byteOrder !== sb.byteOrder ||
        sa.signed !== sb.signed ||
        (sa.muxType ?? '') !== (sb.muxType ?? '') ||
        (sa.muxValue ?? null) !== (sb.muxValue ?? null)
      );
    });
    if (hardBreak) {
      return {
        ...id,
        messageNameA: a.name,
        messageNameB: b.name,
        relation: 'incompatible',
        reason: `同名信号字节序/bit 区间/有符号或多路复用改变（${onlyA.concat(onlyB).slice(0, 4).join(', ')}）`
      };
    }
    return {
      ...id,
      messageNameA: a.name,
      messageNameB: b.name,
      relation: 'compatible',
      reason: `仅缩放/偏置/枚举差异；移除 ${onlyA.join(', ') || '-'}，新增 ${onlyB.join(', ') || '-'}`,
    };
  }
  throw new Error('unreachable');
}

export function compareVersions(
  db: Database.Database,
  versionAId: number,
  versionBId: number
): VersionCompare {
  const versionA = getVersion(db, versionAId);
  const versionB = getVersion(db, versionBId);
  const all = getAllMessagesByVersion(db);
  const listA = all.get(versionAId) ?? [];
  const listB = all.get(versionBId) ?? [];

  const key = (arbId: number, kind: string) => `${arbId}:${kind}`;
  const mapA = new Map(listA.map((m) => [key(m.arbId, m.idKind), m]));
  const mapB = new Map(listB.map((m) => [key(m.arbId, m.idKind), m]));
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);

  const entries = [...keys]
    .map((k) => {
      const [arbStr, kind] = k.split(':');
      return classify(mapA.get(k), mapB.get(k));
    })
    .sort((x, y) => x.arbId - y.arbId || x.idKind.localeCompare(y.idKind));

  // 对同一批帧的影响
  const frameImpact = entries.map((entry) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) c FROM frames f WHERE f.arb_id = ? AND f.id_kind = ?`
      )
      .get(entry.arbId, entry.idKind) as { c: number };
    return {
      arbId: entry.arbId,
      idKind: entry.idKind,
      messageName: entry.messageNameB ?? entry.messageNameA ?? '',
      frameCount: row.c,
      relation: entry.relation
    };
  });

  return { versionA, versionB, entries, frameImpact };
}

function signalMapping(a: MessageDef | undefined, b: MessageDef | undefined) {
  if (!a || !b) return [];
  const out: { from: string; to: string }[] = [];
  const bNames = new Set(b.signals.map((s) => s.name));
  for (const sa of a.signals) {
    out.push({ from: sa.name, to: bNames.has(sa.name) ? sa.name : '' });
  }
  for (const sb of b.signals) {
    if (!a.signals.some((s) => s.name === sb.name)) out.push({ from: '', to: sb.name });
  }
  return out;
}

/** 批准迁移映射 或 标记无法兼容；expectedRevision 做并发冲突检测 */
export function approveMigration(
  db: Database.Database,
  req: {
    fromVersionId: number;
    toVersionId: number;
    arbId: number;
    idKind: 'std' | 'ext';
    status: 'approved' | 'incompatible';
    signalMapping?: { from: string; to: string }[];
    note?: string | null;
    expectedRevision?: number;
  }
): MigrationMapping {
  getVersion(db, req.fromVersionId);
  getVersion(db, req.toVersionId);
  const all = getAllMessagesByVersion(db);
  const msgA = (all.get(req.fromVersionId) ?? []).find(
    (m) => m.arbId === req.arbId && m.idKind === req.idKind
  );
  const msgB = (all.get(req.toVersionId) ?? []).find(
    (m) => m.arbId === req.arbId && m.idKind === req.idKind
  );
  if (req.status === 'approved' && !msgB) {
    throw new MigrationError('目标版本不存在该消息，无法批准迁移（应标记为无法兼容）');
  }
  const mapping = req.signalMapping ?? signalMapping(msgA, msgB);
  if (req.status === 'approved') {
    const bad = mapping.filter((m) => m.from && !m.to);
    if (bad.length && !msgA) {
      throw new MigrationError('存在未映射信号');
    }
  }

  const existing = db
    .prepare('SELECT * FROM migrations WHERE from_version_id = ? AND to_version_id = ? AND arb_id = ? AND id_kind = ?')
    .get(req.fromVersionId, req.toVersionId, req.arbId, req.idKind) as
    | Record<string, unknown>
    | undefined;

  if (existing) {
    if (req.expectedRevision !== undefined && existing.revision !== req.expectedRevision) {
      throw new MigrationError(
        `并发冲突：迁移映射 revision=${existing.revision}，请求基于 ${req.expectedRevision}`
      );
    }
    db.prepare(
      `UPDATE migrations SET status = ?, signal_mapping_json = ?, note = ?, revision = revision + 1
       WHERE id = ?`
    ).run(req.status, JSON.stringify(mapping), req.note ?? null, existing.id);
    return getMigration(db, Number(existing.id));
  }

  const info = db.prepare(
    `INSERT INTO migrations
       (from_version_id, to_version_id, arb_id, id_kind, status, signal_mapping_json, note, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    req.fromVersionId,
    req.toVersionId,
    req.arbId,
    req.idKind,
    req.status,
    JSON.stringify(mapping),
    req.note ?? null,
    new Date().toISOString()
  );
  return getMigration(db, Number(info.lastInsertRowid));
}

export function listMigrations(
  db: Database.Database,
  fromVersionId?: number,
  toVersionId?: number
): MigrationMapping[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (fromVersionId !== undefined) {
    where.push('from_version_id = ?');
    params.push(fromVersionId);
  }
  if (toVersionId !== undefined) {
    where.push('to_version_id = ?');
    params.push(toVersionId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM migrations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY from_version_id, to_version_id, arb_id, id_kind`
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToMigration);
}

function getMigration(db: Database.Database, id: number): MigrationMapping {
  const row = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id);
  if (!row) throw new MigrationError('迁移映射不存在');
  return rowToMigration(row as Record<string, unknown>);
}

function rowToMigration(row: Record<string, unknown>): MigrationMapping {
  return {
    id: row.id as number,
    fromVersionId: row.from_version_id as number,
    toVersionId: row.to_version_id as number,
    arbId: row.arb_id as number,
    idKind: row.id_kind as 'std' | 'ext',
    status: row.status as 'approved' | 'incompatible',
    signalMapping: JSON.parse(row.signal_mapping_json as string),
    note: (row.note as string | null) ?? null,
    revision: row.revision as number,
    createdAt: row.created_at as string
  };
}

export { rowToVersion };
