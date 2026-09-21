import { getDb } from './db';
import { contentHash } from './hash';
import { hexToBytes } from '../core/bits';
import { decodeMessage } from '../core/decode';
import { verifyCrc } from '../core/crc';
import { analyzeCounters, type CounterFrame } from '../core/counter';
import { findMessage, selectVersion, type VersionRow } from '../core/versions';
import { compareFrame, suggestMapping, type CompareFrameInput } from '../core/compare';
import type { DbcDoc, MessageDef } from '../core/types';
import { row } from './sqlutil';

interface DbVersion {
  id: number;
  seq: number;
  label: string;
  start_ns: number;
  end_ns: number | null;
  doc: string;
  content_hash: string;
  created_ms: number;
  row_version: number;
}

const toVersionRow = (r: DbVersion): VersionRow => ({
  id: r.id,
  label: r.label,
  start_ns: r.start_ns,
  end_ns: r.end_ns,
  seq: r.seq,
  doc: JSON.parse(r.doc) as DbcDoc,
});

export function listVersions(): Array<{
  id: number;
  seq: number;
  label: string;
  startNs: number;
  endNs: number | null;
  messageCount: number;
  rowVersion: number;
}> {
  const db = getDb();
  const rows = (
    db.prepare('SELECT * FROM dbc_versions ORDER BY start_ns, seq').all() as Record<string, unknown>[]
  ).map((x) => row<DbVersion>(x));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    label: r.label,
    startNs: r.start_ns,
    endNs: r.end_ns,
    messageCount: (JSON.parse(r.doc) as DbcDoc).messages.length,
    rowVersion: r.row_version,
  }));
}

export function getVersionDoc(id: number): VersionRow | null {
  const db = getDb();
  const raw = db.prepare('SELECT * FROM dbc_versions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  const r = raw ? row<DbVersion>(raw) : undefined;
  return r ? toVersionRow(r) : null;
}

function allVersionRows(): VersionRow[] {
  const db = getDb();
  return (db.prepare('SELECT * FROM dbc_versions').all() as Record<string, unknown>[]).map(
    (x) => toVersionRow(row<DbVersion>(x)),
  );
}

export function addVersion(input: {
  label: string;
  startNs: number;
  endNs: number | null;
  doc: DbcDoc;
}): { id: number; staleDecodings: { frameIds: number[] } } {
  const db = getDb();
  if (input.endNs !== null && input.endNs <= input.startNs) {
    throw httpError(400, '生效区间非法：end 必须大于 start');
  }
  const hash = contentHash(input.doc);
  const seq =
    ((db.prepare('SELECT COALESCE(MAX(seq), 0) m FROM dbc_versions').get() as Record<string, unknown>).m as number) + 1;
  const id =
    ((db.prepare('SELECT COALESCE(MAX(id), 0) m FROM dbc_versions').get() as Record<string, unknown>).m as number) + 1;
  db.prepare(
    `INSERT INTO dbc_versions (id, seq, label, start_ns, end_ns, doc, content_hash, created_ms, row_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, seq, input.label, input.startNs, input.endNs, JSON.stringify(input.doc), hash, Date.now());
  return { id, staleDecodings: staleFramesForVersion(null) };
}

export interface UpdateVersionInput {
  startNs?: number;
  endNs?: number | null;
  expectedRowVersion: number;
}

export function updateVersionInterval(
  id: number,
  input: UpdateVersionInput,
): { rowVersion: number; staleFrameIds: number[] } {
  const db = getDb();
  const currentRaw = db.prepare('SELECT * FROM dbc_versions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  const current = currentRaw ? row<DbVersion>(currentRaw) : undefined;
  if (!current) throw httpError(404, '版本不存在');
  if (current.row_version !== input.expectedRowVersion) {
    throw httpError(409, `版本号冲突：期望 ${input.expectedRowVersion}，当前 ${current.row_version}`);
  }
  const startNs = input.startNs ?? current.start_ns;
  const endNs = input.endNs === undefined ? current.end_ns : input.endNs;
  if (endNs !== null && endNs <= startNs) throw httpError(400, '生效区间非法');

  const before = staleFramesForVersion(id);
  db.prepare('UPDATE dbc_versions SET start_ns = ?, end_ns = ?, row_version = row_version + 1 WHERE id = ?').run(
    startNs,
    endNs,
    id,
  );
  const after = staleFramesForVersion(id);
  const staleFrameIds = [...new Set([...before.frameIds, ...after.frameIds])].sort((a, b) => a - b);
  return { rowVersion: current.row_version + 1, staleFrameIds };
}

/** 计算受某版本生效区间影响（该版本能解析）的帧，用于“过期解码”提示 */
function staleFramesForVersion(versionId: number | null): { frameIds: number[] } {
  const db = getDb();
  const versions = allVersionRows();
  const frames = db.prepare('SELECT id, arb_id, extended, channel, hw_time_ns FROM frames').all() as Array<{
    id: number;
    arb_id: number;
    extended: number;
    channel: string | null;
    hw_time_ns: number;
  }>;
  const ids: number[] = [];
  for (const f of frames) {
    const hit = findMessage(
      versions,
      f.arb_id,
      Boolean(f.extended),
      f.channel,
      f.hw_time_ns,
    );
    if (hit && (versionId === null || hit.version.id === versionId)) ids.push(f.id);
  }
  return { frameIds: ids };
}

/* ---------------- 帧查询 / 时间轴 ---------------- */

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

interface FrameDbRow {
  id: number;
  batch_id: number;
  arb_id: number;
  extended: number;
  channel: string | null;
  hw_time_ns: number;
  generation: number;
  data: Uint8Array;
  data_hex: string;
}

export function listFrames(opts: {
  batchId?: number;
  arbId?: number;
  extended?: boolean;
  generation?: number;
  limit?: number;
}): Array<{
  id: number;
  batchId: number;
  arbId: number;
  extended: boolean;
  channel: string | null;
  hwTimeNs: number;
  generation: number;
  dataHex: string;
  dlc: number;
  messageName: string | null;
  versionId: number | null;
  versionLabel: string | null;
  stale: boolean;
}> {
  const db = getDb();
  const versions = allVersionRows();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.batchId !== undefined) {
    where.push('f.id IN (SELECT frame_id FROM batch_frames WHERE batch_id = ?)');
    params.push(opts.batchId);
  }
  if (opts.arbId !== undefined) {
    where.push('f.arb_id = ?');
    params.push(opts.arbId);
  }
  if (opts.extended !== undefined) {
    where.push('f.extended = ?');
    params.push(opts.extended ? 1 : 0);
  }
  if (opts.generation !== undefined) {
    where.push('f.generation = ?');
    params.push(opts.generation);
  }
  const limit = Math.min(opts.limit ?? 1000, 5000);
  const sql = `SELECT f.* FROM frames f ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY f.hw_time_ns, f.id LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params).map((x) => row<FrameDbRow>(x));
  return rows.map((f) => {
    const hit = findMessage(versions, f.arb_id, Boolean(f.extended), f.channel, f.hw_time_ns);
    return {
      id: f.id,
      batchId: f.batch_id,
      arbId: f.arb_id,
      extended: Boolean(f.extended),
      channel: f.channel,
      hwTimeNs: f.hw_time_ns,
      generation: f.generation,
      dataHex: f.data_hex,
      dlc: f.data.length,
      messageName: hit?.message.name ?? null,
      versionId: hit?.version.id ?? null,
      versionLabel: hit?.version.label ?? null,
      stale: false,
    };
  });
}

export function decodeFrame(frameId: number, versionIdOverride?: number) {
  const db = getDb();
  const fRaw = db.prepare('SELECT * FROM frames WHERE id = ?').get(frameId) as Record<string, unknown> | undefined;
  const f = fRaw ? row<FrameDbRow>(fRaw) : undefined;
  if (!f) throw httpError(404, '帧不存在');
  const versions = allVersionRows();
  const version =
    versionIdOverride !== undefined
      ? versions.find((v) => v.id === versionIdOverride) ?? null
      : selectVersion(versions, f.hw_time_ns);
  if (!version) {
    return {
      frame: frameSummary(f),
      resolution: { resolved: false, reason: 'no-active-version' },
    };
  }
  const message = version.doc.messages.find(
    (m) =>
      m.arbId === f.arb_id &&
      m.extended === Boolean(f.extended) &&
      (m.channel === null || f.channel === null || m.channel === f.channel),
  );
  if (!message) {
    return {
      frame: frameSummary(f),
      resolution: { resolved: false, reason: 'no-message-definition', version: versionBrief(version) },
    };
  }
  const data = f.data;
  const decoded = decodeMessage(message, data);
  const crc = verifyCrc(message, data);
  return {
    frame: frameSummary(f),
    resolution: { resolved: true, version: versionBrief(version) },
    messageDef: messageBrief(message),
    decoded,
    crc,
  };
}

function frameSummary(f: FrameDbRow) {
  return {
    id: f.id,
    batchId: f.batch_id,
    arbId: f.arb_id,
    extended: Boolean(f.extended),
    channel: f.channel,
    hwTimeNs: f.hw_time_ns,
    generation: f.generation,
    dataHex: f.data_hex,
    dlc: f.data.length,
  };
}

function versionBrief(v: VersionRow) {
  return { id: v.id, label: v.label, startNs: v.start_ns, endNs: v.end_ns };
}

function messageBrief(m: MessageDef) {
  return {
    arbId: m.arbId,
    extended: m.extended,
    channel: m.channel,
    name: m.name,
    dlc: m.dlc,
    transmitter: m.transmitter,
  };
}

/* ---------------- 计数器（节点 × 采集代次） ---------------- */

export function counterReport() {
  const db = getDb();
  const versions = allVersionRows();
  const rows = db.prepare('SELECT * FROM frames ORDER BY hw_time_ns, id').all().map((x) => row<FrameDbRow>(x));
  const counterFrames: CounterFrame[] = [];
  const skipped: string[] = [];
  for (const f of rows) {
    const hit = findMessage(versions, f.arb_id, Boolean(f.extended), f.channel, f.hw_time_ns);
    if (!hit || !hit.message.counter) continue;
    const sig = hit.message.signals.find((s) => s.name === hit.message.counter!.signal);
    if (!sig) {
      skipped.push(`帧 ${f.id}: 计数器信号未找到`);
      continue;
    }
    const decoded = decodeMessage(hit.message, f.data);
    const dsig = decoded.signals.find((s) => s.name === sig.name);
    counterFrames.push({
      id: f.id,
      node: hit.message.transmitter ?? `0x${f.arb_id.toString(16).toUpperCase()}`,
      generation: f.generation,
      hwTimeNs: f.hw_time_ns,
      counterRaw: dsig?.raw ?? 0,
      width: sig.length,
    });
  }
  return { series: analyzeCounters(counterFrames), skipped };
}

/* ---------------- CRC 证据 ---------------- */

export function crcReport() {
  const db = getDb();
  const versions = allVersionRows();
  const rows = db.prepare('SELECT * FROM frames ORDER BY hw_time_ns, id').all().map((x) => row<FrameDbRow>(x));
  const evidences = [];
  for (const f of rows) {
    const hit = findMessage(versions, f.arb_id, Boolean(f.extended), f.channel, f.hw_time_ns);
    if (!hit || !hit.message.crc) continue;
    evidences.push({
      frameId: f.id,
      messageName: hit.message.name,
      ...verifyCrc(hit.message, f.data),
    });
  }
  const summary = {
    pass: evidences.filter((e) => e.status === 'pass').length,
    fail: evidences.filter((e) => e.status === 'fail').length,
    notVerified: evidences.filter((e) => e.status === 'not-verified').length,
    truncated: evidences.filter((e) => e.status === 'truncated').length,
  };
  return { summary, evidences };
}

/* ---------------- 两个 DBC 版本对比 ---------------- */

export function compareVersions(fromId: number, toId: number, batchId?: number) {
  const from = getVersionDoc(fromId);
  const to = getVersionDoc(toId);
  if (!from || !to) throw httpError(404, 'DBC 版本不存在');
  const db = getDb();
  const rows = (
    batchId !== undefined
      ? (db
          .prepare(
            `SELECT f.* FROM frames f JOIN batch_frames bf ON bf.frame_id = f.id
             WHERE bf.batch_id = ? ORDER BY f.hw_time_ns, f.id`,
          )
          .all(batchId).map((x) => row<FrameDbRow>(x)))
      : (db.prepare('SELECT * FROM frames ORDER BY hw_time_ns, id').all().map((x) => row<FrameDbRow>(x)))
  );
  const comparisons = rows.map((f) => {
    const input: CompareFrameInput = {
      id: f.id,
      arbId: f.arb_id,
      extended: Boolean(f.extended),
      channel: f.channel,
      hwTimeNs: f.hw_time_ns,
      dataHex: f.data_hex,
    };
    return compareFrame(input, from.doc, to.doc);
  });
  return {
    from: versionBrief(from),
    to: versionBrief(to),
    frames: comparisons,
    stats: {
      total: comparisons.length,
      compatible: comparisons.filter((c) => c.compatible).length,
      incompatible: comparisons.filter((c) => !c.compatible).length,
    },
  };
}

/* ---------------- 迁移映射 + 乐观并发审批 ---------------- */

export function proposeMigration(fromId: number, toId: number, arbId: number, extended: boolean) {
  const from = getVersionDoc(fromId);
  const to = getVersionDoc(toId);
  if (!from || !to) throw httpError(404, 'DBC 版本不存在');
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM frames WHERE arb_id = ? AND extended = ? ORDER BY hw_time_ns, id',
    )
    .all(arbId, extended ? 1 : 0).map((x) => row<FrameDbRow>(x));
  if (rows.length === 0) throw httpError(404, '该 arbitration id 没有帧');

  const comparisons = rows.map((f) =>
    compareFrame(
      {
        id: f.id,
        arbId: f.arb_id,
        extended: Boolean(f.extended),
        channel: f.channel,
        hwTimeNs: f.hw_time_ns,
        dataHex: f.data_hex,
      },
      from.doc,
      to.doc,
    ),
  );

  // 合并所有帧的建议映射：同名兼容才自动映射
  const mapping: Record<string, string | null> = {};
  for (const c of comparisons) {
    const suggested = suggestMapping(c);
    for (const [name, target] of Object.entries(suggested)) {
      if (mapping[name] === undefined) mapping[name] = target;
      else if (mapping[name] !== target) mapping[name] = null;
    }
  }
  const incompatibleSignals = comparisons.flatMap((c) =>
    c.signals.filter((s) => !s.compatible).map((s) => ({ frameId: c.frameId, signal: s.signal, note: s.note })),
  );
  const compatible = comparisons.every((c) => c.compatible);
  const summary = compatible
    ? '全部信号可按同名自动迁移'
    : `${new Set(incompatibleSignals.map((i) => i.signal)).size} 个信号存在不兼容变化`;

  const existing = db
    .prepare('SELECT id FROM migrations WHERE from_version_id = ? AND to_version_id = ? AND arb_id = ? AND extended = ?')
    .get(fromId, toId, arbId, extended ? 1 : 0) as Record<string, unknown> | undefined;
  if (existing) {
    const existingId = existing.id as number;
    db.prepare(
      'UPDATE migrations SET mapping = ?, summary = ?, frame_count = ?, updated_ms = ? WHERE id = ?',
    ).run(JSON.stringify(mapping), summary, rows.length, Date.now(), existingId);
    return { id: existingId, compatible, mapping, summary, incompatibleSignals };
  }
  const id =
    ((db.prepare('SELECT COALESCE(MAX(id), 0) m FROM migrations').get() as Record<string, unknown>).m as number) + 1;
  db.prepare(
    `INSERT INTO migrations (id, from_version_id, to_version_id, arb_id, extended, frame_count, mapping, summary, status, row_version, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?)`,
  ).run(id, fromId, toId, arbId, extended ? 1 : 0, rows.length, JSON.stringify(mapping), summary, Date.now());
  return { id, compatible, mapping, summary, incompatibleSignals };
}

export function decideMigration(
  id: number,
  decision: 'approved' | 'incompatible',
  mapping: Record<string, string | null> | null,
  expectedRowVersion: number,
) {
  const db = getDb();
  const rowRaw = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const migRow = rowRaw as (Record<string, unknown> & { row_version: number; status: string }) | undefined;
  if (!migRow) throw httpError(404, '迁移映射不存在');
  if (migRow.row_version !== expectedRowVersion) {
    throw httpError(
      409,
      `并发审批冲突：你基于版本号 ${expectedRowVersion}，当前已是 ${migRow.row_version}`,
    );
  }
  if (decision === 'approved' && mapping) {
    db.prepare('UPDATE migrations SET status = ?, mapping = ?, row_version = row_version + 1, updated_ms = ? WHERE id = ?').run(
      'approved',
      JSON.stringify(mapping),
      Date.now(),
      id,
    );
  } else {
    db.prepare('UPDATE migrations SET status = ?, row_version = row_version + 1, updated_ms = ? WHERE id = ?').run(
      decision,
      Date.now(),
      id,
    );
  }
  return getMigration(id);
}

export function listMigrations() {
  const db = getDb();
  return (
    db
      .prepare('SELECT * FROM migrations ORDER BY id')
      .all() as Array<Record<string, unknown>>
  ).map(serializeMigration);
}

function getMigration(id: number) {
  const db = getDb();
  const raw = db.prepare('SELECT * FROM migrations WHERE id = ?').get(id) as Record<string, unknown>;
  return serializeMigration(row<Record<string, unknown>>(raw));
}

function serializeMigration(row: Record<string, unknown>) {
  return {
    id: row.id,
    fromVersionId: row.from_version_id,
    toVersionId: row.to_version_id,
    arbId: row.arb_id,
    extended: Boolean(row.extended),
    frameCount: row.frame_count,
    mapping: JSON.parse(row.mapping as string),
    summary: row.summary,
    status: row.status,
    rowVersion: row.row_version,
    updatedMs: row.updated_ms,
  };
}

/* ---------------- 冻结调查快照 ---------------- */

export function createInvestigation(input: {
  name: string;
  note?: string;
  frameIds: number[];
  versionIdOverride?: number | null;
}) {
  const db = getDb();
  const id =
    ((db.prepare('SELECT COALESCE(MAX(id), 0) m FROM investigations').get() as Record<string, unknown>).m as number) + 1;
  db.prepare(
    'INSERT INTO investigations (id, name, created_ms, frozen_version_ids, note) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.name, Date.now(), '[]', input.note ?? null);
  const versions = allVersionRows();
  const frozenIds = new Set<number>();
  const rows: unknown[] = [];

  const insertRow = db.prepare(
    `INSERT INTO investigation_rows
       (id, investigation_id, frame_id, frame_arb_id, frame_extended, frame_time_ns, frame_data_hex,
        version_id, version_label, message_name, decoded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let rowSeq =
    ((db.prepare('SELECT COALESCE(MAX(id), 0) m FROM investigation_rows').get() as Record<string, unknown>).m as number) + 1;

  for (const frameId of input.frameIds) {
    const fRaw = db.prepare('SELECT * FROM frames WHERE id = ?').get(frameId) as Record<string, unknown> | undefined;
  const f = fRaw ? row<FrameDbRow>(fRaw) : undefined;
    if (!f) continue;
    const hit = input.versionIdOverride
      ? (() => {
          const v = versions.find((x) => x.id === input.versionIdOverride);
          if (!v) return null;
          const m = v.doc.messages.find(
            (mm) =>
              mm.arbId === f.arb_id &&
              mm.extended === Boolean(f.extended) &&
              (mm.channel === null || f.channel === null || mm.channel === f.channel),
          );
          return m ? { version: v, message: m } : null;
        })()
      : findMessage(versions, f.arb_id, Boolean(f.extended), f.channel, f.hw_time_ns);
    const decoded = hit
      ? {
          messageDef: messageBrief(hit.message),
          decoded: decodeMessage(hit.message, f.data),
          crc: verifyCrc(hit.message, f.data),
        }
      : { resolved: false, reason: 'no-message-definition' };
    if (hit) frozenIds.add(hit.version.id);
    insertRow.run(
      rowSeq++,
      id,
      f.id,
      f.arb_id,
      f.extended ? 1 : 0,
      f.hw_time_ns,
      f.data_hex,
      hit?.version.id ?? -1,
      hit?.version.label ?? '(无定义)',
      hit?.message.name ?? null,
      JSON.stringify(decoded),
    );
    rows.push(decoded);
  }

  db.prepare('UPDATE investigations SET frozen_version_ids = ? WHERE id = ?').run(
    JSON.stringify([...frozenIds].sort((a, b) => a - b)),
    id,
  );
  return { id, frozenVersionIds: [...frozenIds], rows: rows.length };
}

export function listInvestigations() {
  const db = getDb();
  const invs = db.prepare('SELECT * FROM investigations ORDER BY id').all() as Array<{
    id: number;
    name: string;
    created_ms: number;
    frozen_version_ids: string;
    note: string | null;
  }>;
  return invs.map((i) => ({
    id: i.id,
    name: i.name,
    createdMs: i.created_ms,
    frozenVersionIds: JSON.parse(i.frozen_version_ids),
    note: i.note,
  }));
}

export function getInvestigation(id: number) {
  const db = getDb();
  const invRaw = db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  const inv = invRaw
    ? (row(invRaw) as { id: number; name: string; created_ms: number; frozen_version_ids: string; note: string | null })
    : undefined;
  if (!inv) throw httpError(404, '调查不存在');
  const rows = db
    .prepare('SELECT * FROM investigation_rows WHERE investigation_id = ? ORDER BY frame_time_ns, frame_id')
    .all(id) as Array<{
    id: number;
    frame_id: number;
    frame_arb_id: number;
    frame_extended: number;
    frame_time_ns: number;
    frame_data_hex: string;
    version_id: number;
    version_label: string;
    message_name: string | null;
    decoded: string;
  }>;
  return {
    id: inv.id,
    name: inv.name,
    createdMs: inv.created_ms,
    note: inv.note,
    frozenVersionIds: JSON.parse(inv.frozen_version_ids),
    rows: rows.map((r) => ({
      rowId: r.id,
      frameId: r.frame_id,
      arbId: r.frame_arb_id,
      extended: Boolean(r.frame_extended),
      hwTimeNs: r.frame_time_ns,
      dataHex: r.frame_data_hex,
      versionId: r.version_id,
      versionLabel: r.version_label,
      messageName: r.message_name,
      decoded: JSON.parse(r.decoded),
    })),
  };
}

export function listBatches() {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT b.id, b.name, b.imported_at_ms, COUNT(bf.frame_id) AS frame_count
         FROM batches b LEFT JOIN batch_frames bf ON bf.batch_id = b.id
         GROUP BY b.id ORDER BY b.id`,
      )
      .all() as Array<{ id: number; name: string; imported_at_ms: number; frame_count: number }>
  ).map((b) => ({
    id: b.id,
    name: b.name,
    importedAtMs: b.imported_at_ms,
    frameCount: b.frame_count,
  }));
}
