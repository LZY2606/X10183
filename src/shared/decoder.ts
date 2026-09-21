import {
  encodeBits,
  enumLabelFor,
  interpretSigned,
  physicalValue,
  readBits,
  signalCells,
} from './codec.js';
import type {
  DbcDoc,
  DecodeResult,
  DecodedSignal,
  IdKind,
  MessageDef,
  SignalDef,
  UndecodedSignal,
} from './types.js';
import { messageKey } from './types.js';

/** 在一个 DBC 文档中按 (id, 帧类型) 找消息定义；标准/扩展互不混淆 */
export function findMessage(doc: DbcDoc, id: number, kind: IdKind): MessageDef | undefined {
  return doc.messages.find((m) => m.id === id && m.idKind === kind);
}

export function muxBranchOf(sig: SignalDef): number | null {
  if (!sig.muxKind || sig.muxKind === 'm') return null;
  const n = Number(sig.muxKind.slice(1));
  return Number.isFinite(n) ? n : null;
}

export function isMuxSwitch(sig: SignalDef): boolean {
  return sig.muxKind === 'm';
}

export interface EffectiveMessage {
  message: MessageDef;
  revisionId: number;
  revisionLabel: string;
  revisionNumber: number;
}

export function decodeWithMessage(
  data: number[],
  eff: EffectiveMessage
): DecodeResult {
  const { message } = eff;
  const signals: DecodedSignal[] = [];
  const undecoded: UndecodedSignal[] = [];

  const switches = message.signals.filter(isMuxSwitch);
  const switchValues = new Map<string, number>();
  let muxSwitchValue: number | undefined;

  for (const sw of switches) {
    const cells = signalCells(sw);
    const raw = readBits(data, cells);
    switchValues.set(sw.name, raw);
    muxSwitchValue ??= raw;
    signals.push(toDecoded(sw, data, cells, raw, 'switch', raw, undefined));
  }

  // 无 mux 时：单一隐式分支（所有普通信号都解码）
  const activeBranch: number | null = switches.length === 0 ? null : muxSwitchValue ?? null;
  const knownBranches = new Set(
    message.signals.map(muxBranchOf).filter((b): b is number => b !== null)
  );

  for (const sig of message.signals) {
    if (isMuxSwitch(sig)) continue;
    const branch = muxBranchOf(sig);
    if (branch === null) {
      // 普通信号（与 mux 无关）始终解码
      const cells = signalCells(sig);
      const raw = readBits(data, cells);
      signals.push(toDecoded(sig, data, cells, raw, 'data', undefined, undefined));
      continue;
    }
    if (activeBranch !== null && branch === activeBranch) {
      const cells = signalCells(sig);
      const raw = readBits(data, cells);
      signals.push(toDecoded(sig, data, cells, raw, 'data', undefined, branch));
    } else {
      // 分支未知 / 未命中：保留 raw bits 供冻结调查
      const cells = signalCells(sig);
      undecoded.push({
        name: sig.name,
        startBit: sig.startBit,
        length: sig.length,
        byteOrder: sig.byteOrder,
        muxKind: sig.muxKind,
        rawBits: cells.map((c) => ((data[c.byteIndex] ?? 0) >> c.bitInByte) & 1),
        bitTrace: cells,
        reason: 'mux-branch-unknown',
      });
    }
  }

  // 信号按定义顺序排序输出（稳定，不依赖导入顺序）
  signals.sort((a, b) => a.startBit - b.startBit || a.name.localeCompare(b.name));

  return {
    matched: true,
    messageName: message.name,
    messageId: message.id,
    idKind: message.idKind,
    revisionId: eff.revisionId,
    revisionLabel: eff.revisionLabel,
    revisionNumber: eff.revisionNumber,
    muxSwitchValue,
    signals,
    undecoded,
  };
}

function toDecoded(
  sig: SignalDef,
  data: number[],
  cells: ReturnType<typeof signalCells>,
  raw: number,
  muxRole: 'switch' | 'data',
  muxValue: number | undefined,
  muxBranch: number | undefined
): DecodedSignal {
  const signedRaw = interpretSigned(raw, sig.length, sig.signed);
  return {
    name: sig.name,
    raw,
    physical: physicalValue(signedRaw, sig.factor, sig.offset),
    enumLabel: enumLabelFor(sig, raw),
    unit: sig.unit,
    factor: sig.factor,
    offset: sig.offset,
    byteOrder: sig.byteOrder,
    signed: sig.signed,
    startBit: sig.startBit,
    length: sig.length,
    bitTrace: cells,
    muxRole,
    muxValue,
    muxBranch,
  };
}

export function decodeFrame(
  doc: DbcDoc | undefined,
  eff: Omit<EffectiveMessage, 'message'> | undefined,
  id: number,
  kind: IdKind,
  data: number[]
): DecodeResult {
  if (!doc || !eff) {
    return { matched: false, signals: [], undecoded: [], reason: 'no-effective-revision' };
  }
  const message = findMessage(doc, id, kind);
  if (!message) {
    return { matched: false, signals: [], undecoded: [], reason: 'no-message-def' };
  }
  return decodeWithMessage(data, {
    message,
    revisionId: eff.revisionId,
    revisionLabel: eff.revisionLabel,
    revisionNumber: eff.revisionNumber,
  });
}

export { messageKey, encodeBits };
