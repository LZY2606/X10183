import { decodeFrame } from '../core/decode.js';
import { extractRaw } from '../core/bits.js';
import { analyzeCounter } from '../core/counters.js';
import { checkCrcConfig, verifyCrc } from '../core/crc.js';
import { compareDbcVersions } from '../core/versions.js';
import {
  currentDefinitionHash,
  frameRowToStored,
  getFrame,
  getInterpretation,
  getSnapshot,
  listCrcConfigs,
  listCounterConfigs,
  listFrames,
  saveInterpretation,
  saveSnapshot,
  type CrcCfgRow,
} from './repositories.js';
import { loadDbcDocument, loadMessageDefs, resolveDbcForTime, type DbHandle } from './db.js';
import type { DbcDocument, DecodedFrame, RawFrame } from '../core/types.js';

function frameRowToRaw(f: ReturnType<typeof listFrames>[number]): RawFrame {
  return {
    generation: f.generation,
    channel: f.channel,
    id: f.arbitrationId,
    isExtended: f.isExtended,
    direction: f.direction,
    hwTime: f.hwTime,
    dlc: f.dlc,
    data: f.data,
  };
}

/** Decode every frame stored, using the version effective at each frame's HW time. */
export function interpretAllFrames(handle: DbHandle): { decoded: number; unmatched: number } {
  const frames = listFrames(handle);
  let decoded = 0;
  let unmatched = 0;
  const docCache = new Map<number, DbcDocument>();
  const hashCache = new Map<number, string>();
  const messageRowCache = new Map<string, number>();

  for (const frame of frames) {
    const version = resolveDbcForTime(handle, frame.hwTime);
    if (!version) {
      unmatched++;
      continue;
    }
    let doc = docCache.get(version.id);
    if (!doc) {
      doc = loadDbcDocument(handle, version.id);
      docCache.set(version.id, doc);
      hashCache.set(version.id, currentDefinitionHash(handle, version.id) as string);
    }
    const result = decodeFrame(
      frameRowToRaw(frame),
      doc,
      { id: version.id, versionNumber: version.versionNumber, frameRowId: frame.id }
    );
    if (!result.decoded || !result.message) {
      unmatched++;
      continue;
    }
    const cacheKey = `${version.id}:${result.message.messageId}:${result.message.isExtended ? 1 : 0}`;
    let messageRowId = messageRowCache.get(cacheKey);
    if (messageRowId === undefined) {
      const row = handle.db
        .prepare('SELECT id FROM messages WHERE dbc_version_id = ? AND arbitration_id = ? AND is_extended = ?')
        .get(version.id, result.message.messageId, result.message.isExtended ? 1 : 0) as { id: number } | undefined;
      messageRowId = row?.id ?? -1;
      messageRowCache.set(cacheKey, messageRowId);
    }
    saveInterpretation(handle, frame.id, version.id, messageRowId, hashCache.get(version.id) as string, result.decoded);
    decoded++;
  }
  return { decoded, unmatched };
}

export interface FrameInterpretation {
  frame: ReturnType<typeof getFrame>;
  decoded: DecodedFrame | null;
  stale: boolean;
  versionNumber: number;
  frozenSnapshotId?: number;
  note?: string;
}

export function interpretFrame(
  handle: DbHandle,
  frameId: number,
  preferredVersionId?: number
): FrameInterpretation | undefined {
  const frame = getFrame(handle, frameId);
  if (!frame) return undefined;
  const version =
    preferredVersionId !== undefined
      ? listVersionsCached(handle).find((v) => v.id === preferredVersionId)
      : resolveDbcForTime(handle, frame.hwTime);
  if (!version) {
    return { frame, decoded: null, stale: false, versionNumber: -1, note: 'no effective DBC version at this HW time' };
  }
  const doc = loadDbcDocument(handle, version.id);
  const result = decodeFrame(
    frameRowToRaw(frame),
    doc,
    { id: version.id, versionNumber: version.versionNumber, frameRowId: frame.id }
  );

  // Stale = an earlier interpretation exists under a version whose definition
  // no longer matches (or the frame would now resolve to a different version).
  const liveVersion = resolveDbcForTime(handle, frame.hwTime);
  let stale = false;
  const prior = getInterpretation(handle, frameId, version.id);
  if (prior && currentDefinitionHash(handle, version.id) !== prior.definitionHash) stale = true;
  if (liveVersion && liveVersion.id !== version.id) stale = true;

  return {
    frame,
    decoded: result.decoded,
    stale,
    versionNumber: version.versionNumber,
    note: result.reason,
  };
}

function listVersionsCached(handle: DbHandle) {
  return (
    handle.db.prepare('SELECT id, version_number, valid_from, valid_to FROM dbc_versions ORDER BY version_number').all() as
      Record<string, unknown>[]
  ).map((r) => ({
    id: Number(r.id),
    versionNumber: Number(r.version_number),
    validFrom: Number(r.valid_from),
    validTo: r.valid_to === null ? null : Number(r.valid_to),
  }));
}

export function signalCurve(
  handle: DbHandle,
  messageId: number,
  isExtended: boolean,
  signalName: string,
  versionId?: number
): { points: { frameId: number; hwTime: number; generation: number; raw: number | null; value: number | null }[]; versionNumber: number } {
  const frames = listFrames(handle, { id: messageId, isExtended });
  const points: { frameId: number; hwTime: number; generation: number; raw: number | null; value: number | null }[] = [];
  for (const frame of frames) {
    const version = versionId !== undefined
      ? listVersionsCached(handle).find((v) => v.id === versionId)
      : resolveDbcForTime(handle, frame.hwTime);
    if (!version) continue;
    const doc = loadDbcDocument(handle, version.id);
    const result = decodeFrame(frameRowToRaw(frame), doc, { id: version.id, versionNumber: version.versionNumber, frameRowId: frame.id });
    const sig = result.decoded?.signals.find((s) => s.name === signalName && s.active);
    if (sig) points.push({ frameId: frame.id, hwTime: frame.hwTime, generation: frame.generation, raw: sig.raw, value: sig.value });
  }
  const vn = versionId !== undefined ? listVersionsCached(handle).find((v) => v.id === versionId)?.versionNumber ?? -1 : -1;
  return { points, versionNumber: vn };
}

export function runCounterChecks(handle: DbHandle) {
  const configs = listCounterConfigs(handle);
  const reports: unknown[] = [];
  for (const cfg of configs) {
    const frames = listFrames(handle, { id: cfg.arbitrationId, isExtended: cfg.isExtended });
    // Resolve the signal through the effective version per frame, pull raw counter.
    const withRaw = frames.map((frame) => {
      const version = resolveDbcForTime(handle, frame.hwTime);
      let counterRaw: number | null = null;
      if (version) {
        const doc = loadDbcDocument(handle, version.id);
        const result = decodeFrame(frameRowToRaw(frame), doc, { id: version.id, versionNumber: version.versionNumber, frameRowId: frame.id });
        const sig = result.decoded?.signals.find((s) => s.name === cfg.signalName && s.active);
        counterRaw = sig?.raw ?? null;
      }
      return { ...frameRowToStored(frame), counterRaw, contentHash: frame.contentHash };
    });
    const groupReports = analyzeCounter(withRaw, {
      id: cfg.id,
      messageId: cfg.arbitrationId,
      isExtended: cfg.isExtended,
      node: cfg.node,
      signalName: cfg.signalName,
      modulus: cfg.modulus,
      increment: cfg.increment,
    });
    reports.push({ config: cfg, reports: groupReports });
  }
  return reports;
}

function crcConfigFromRow(row: CrcCfgRow) {
  const coverage =
    row.coverageMode === 'bytes' && row.coverageFirst !== null && row.coverageLast !== null
      ? { mode: 'bytes' as const, first: row.coverageFirst, last: row.coverageLast }
      : row.coverageMode === 'exclude'
        ? { mode: 'exclude' as const, positions: row.coveragePositions }
        : { mode: 'all' as const };
  return {
    width: row.width as 8 | 16 | 32 | null,
    poly: row.poly,
    init: row.init,
    xorOut: row.xorOut,
    reflectIn: row.reflectIn,
    reflectOut: row.reflectOut,
    coverage,
    crcBytePositions: row.crcPositions,
    expectedSignalName: row.signalName ?? undefined,
  };
}

export function runCrcChecks(handle: DbHandle) {
  const configs = listCrcConfigs(handle);
  const out: unknown[] = [];
  for (const row of configs) {
    const partial = crcConfigFromRow(row);
    const completeness = checkCrcConfig(partial as never);
    const frames = listFrames(handle, { id: row.arbitrationId, isExtended: row.isExtended });
    const results = frames.map((frame) => {
      let expected: number | null = null;
      let expectedFromSignal: string | null = null;
      const version = resolveDbcForTime(handle, frame.hwTime);
      if (version && row.signalName) {
        const doc = loadDbcDocument(handle, version.id);
        const result = decodeFrame(frameRowToRaw(frame), doc, { id: version.id, versionNumber: version.versionNumber, frameRowId: frame.id });
        const sig = result.decoded?.signals.find((s) => s.name === row.signalName && s.active);
        if (sig) {
          expected = sig.raw ?? null;
          expectedFromSignal = sig.name;
        }
      }
      const verdict = verifyCrc(frame.data, expected, partial as never);
      return { frameId: frame.id, hwTime: frame.hwTime, expected, expectedFromSignal, ...verdict };
    });
    out.push({
      messageKey: row.messageKey,
      complete: completeness.complete,
      missing: completeness.missing,
      results,
    });
  }
  return out;
}

export function compareVersions(handle: DbHandle, fromId: number, toId: number) {
  const from = loadMessageDefs(handle, fromId);
  const to = loadMessageDefs(handle, toId);
  return compareDbcVersions(from, to);
}

export function freezeSnapshot(
  handle: DbHandle,
  frameId: number,
  title: string,
  note: string,
  versionId?: number
): number {
  const interp = interpretFrame(handle, frameId, versionId);
  if (!interp || !interp.decoded) throw new Error('cannot snapshot: frame has no interpretation');
  const usedVersionId = interp.decoded.dbcVersionId;
  const definition = loadMessageDefs(handle, usedVersionId).find(
    (m: ReturnType<typeof loadMessageDefs>[number]) => m.messageId === interp.decoded!.messageId && m.isExtended === interp.decoded!.isExtended
  );
  return saveSnapshot(handle, title, note, frameId, usedVersionId, interp.frame, definition, interp.decoded);
}

export function readSnapshot(handle: DbHandle, snapshotId: number) {
  return getSnapshot(handle, snapshotId);
}

export { extractRaw };
