import type { MessageDef } from './types';

export interface VersionRow {
  id: number;
  label: string;
  start_ns: number;
  end_ns: number | null;
  seq: number;
  doc: { messages: MessageDef[]; nodes: string[] };
}

/** 生效区间：[start, end)，end 为 null 表示开放。同点多版本时取 seq 最大者。 */
export function selectVersion<T extends { start_ns: number; end_ns: number | null; seq: number }>(
  versions: T[],
  timeNs: number,
): T | null {
  const covering = versions.filter(
    (v) => v.start_ns <= timeNs && (v.end_ns === null || timeNs < v.end_ns),
  );
  if (covering.length === 0) return null;
  covering.sort((a, b) => a.start_ns - b.start_ns || b.seq - a.seq);
  return covering[covering.length - 1];
}

export function findMessage(
  versions: VersionRow[],
  arbId: number,
  extended: boolean,
  channel: string | null,
  timeNs: number,
): { version: VersionRow; message: MessageDef } | null {
  const v = selectVersion(versions, timeNs);
  if (!v) return null;
  const msg = v.doc.messages.find(
    (m) =>
      m.arbId === arbId &&
      m.extended === extended &&
      (m.channel === null || channel === null || m.channel === channel),
  );
  if (!msg) return null;
  return { version: v, message: msg };
}
