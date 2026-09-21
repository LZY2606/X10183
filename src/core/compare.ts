import { decodeMessage } from './decode';
import { hexToBytes } from './bits';
import type { DbcDoc, MessageDef, SignalDef } from './types';

export interface CompareFrameInput {
  id: number;
  arbId: number;
  extended: boolean;
  channel: string | null;
  hwTimeNs: number;
  dataHex: string;
}

export type SignalStatus = 'unchanged' | 'changed' | 'added' | 'removed';

export interface SignalComparison {
  signal: string;
  status: SignalStatus;
  from: {
    raw: number | null;
    value: number | null;
    enumLabel: string | null;
    bitRange: { first: number; last: number } | null;
    def: SignalSummary | null;
  };
  to: {
    raw: number | null;
    value: number | null;
    enumLabel: string | null;
    bitRange: { first: number; last: number } | null;
    def: SignalSummary | null;
  };
  compatible: boolean;
  note: string | null;
}

export interface SignalSummary {
  startBit: number;
  length: number;
  byteOrder: string;
  signed: boolean;
  factor: number;
  offset: number;
}

export interface FrameComparison {
  frameId: number;
  arbId: number;
  extended: boolean;
  hwTimeNs: number;
  fromMessage: string | null;
  toMessage: string | null;
  resolvable: { from: boolean; to: boolean };
  signals: SignalComparison[];
  compatible: boolean;
  notes: string[];
}

function summary(sig: SignalDef): SignalSummary {
  return {
    startBit: sig.startBit,
    length: sig.length,
    byteOrder: sig.byteOrder,
    signed: sig.signed,
    factor: sig.factor,
    offset: sig.offset,
  };
}

function pick(doc: DbcDoc, frame: CompareFrameInput): MessageDef | null {
  return (
    doc.messages.find(
      (m) =>
        m.arbId === frame.arbId &&
        m.extended === frame.extended &&
        (m.channel === null || frame.channel === null || m.channel === frame.channel),
    ) ?? null
  );
}

export function compareFrame(
  frame: CompareFrameInput,
  fromDoc: DbcDoc | null,
  toDoc: DbcDoc | null,
): FrameComparison {
  const fromMsg = fromDoc ? pick(fromDoc, frame) : null;
  const toMsg = toDoc ? pick(toDoc, frame) : null;
  const notes: string[] = [];
  const data = hexToBytes(frame.dataHex);

  if (!fromMsg) notes.push('旧版本中未解析（无消息定义）');
  if (!toMsg) notes.push('新版本中未解析（无消息定义）');

  const fromDec = fromMsg ? decodeMessage(fromMsg, data) : null;
  const toDec = toMsg ? decodeMessage(toMsg, data) : null;

  const fromSigs = new Map(
    (fromDec?.signals ?? []).map((s) => [s.name, s] as const),
  );
  const toSigs = new Map((toDec?.signals ?? []).map((s) => [s.name, s] as const));
  const fromDefs = new Map((fromMsg?.signals ?? []).map((s) => [s.name, s] as const));
  const toDefs = new Map((toMsg?.signals ?? []).map((s) => [s.name, s] as const));

  const names = new Set<string>([...fromSigs.keys(), ...toSigs.keys()]);
  const comparisons: SignalComparison[] = [];

  for (const name of [...names].sort()) {
    const a = fromSigs.get(name) ?? null;
    const b = toSigs.get(name) ?? null;
    const status: SignalStatus =
      a && b ? 'changed' : b ? 'added' : 'removed';
    const defChanged =
      a && b && JSON.stringify(summary(fromDefs.get(name)!)) !== JSON.stringify(summary(toDefs.get(name)!));
    const valueChanged =
      a && b && (a.raw !== b.raw || a.value !== b.value || a.enumLabel !== b.enumLabel);
    const compatible =
      status !== 'removed' &&
      (status === 'added' || (!defChanged && !valueChanged));
    let note: string | null = null;
    if (status === 'removed') note = '信号在新版本中被删除';
    else if (status === 'added') note = '新版本新增信号';
    else if (defChanged && valueChanged) note = '布局与解码值均变化';
    else if (defChanged) note = '定义变化（字节序/缩放/偏置/位区间）';
    else if (valueChanged) note = '布局相同但解释值变化';
    comparisons.push({
      signal: name,
      status: status === 'changed' && !defChanged && !valueChanged ? 'unchanged' : status,
      from: {
        raw: a?.raw ?? null,
        value: a?.value ?? null,
        enumLabel: a?.enumLabel ?? null,
        bitRange: a ? a.bitRange : null,
        def: fromDefs.get(name) ? summary(fromDefs.get(name)!) : null,
      },
      to: {
        raw: b?.raw ?? null,
        value: b?.value ?? null,
        enumLabel: b?.enumLabel ?? null,
        bitRange: b ? b.bitRange : null,
        def: toDefs.get(name) ? summary(toDefs.get(name)!) : null,
      },
      compatible,
      note,
    });
  }

  const compatible =
    !!toMsg && comparisons.every((c) => c.compatible);
  if (fromMsg && toMsg && fromMsg.name !== toMsg.name) {
    notes.push(`消息改名: ${fromMsg.name} → ${toMsg.name}`);
  }

  return {
    frameId: frame.id,
    arbId: frame.arbId,
    extended: frame.extended,
    hwTimeNs: frame.hwTimeNs,
    fromMessage: fromMsg?.name ?? null,
    toMessage: toMsg?.name ?? null,
    resolvable: { from: !!fromMsg, to: !!toMsg },
    signals: comparisons,
    compatible,
    notes,
  };
}

/** 基于比较结果生成建议迁移映射（同名且兼容的信号自动映射） */
export function suggestMapping(comparison: FrameComparison): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  for (const c of comparison.signals) {
    if (c.status === 'unchanged' || c.status === 'changed') {
      mapping[c.signal] = c.compatible ? c.signal : null;
    }
  }
  return mapping;
}
