import type {
  DecodedFrame,
  DecodedSignal,
  MessageDef,
  RawFrame,
  SignalDef
} from './types.js';
import {
  compactBitRanges,
  extractRaw,
  hexToBytes,
  physicalValue,
  signalBitPositions,
  signExtend
} from './bits.js';

/** 同 arbitration id 必须同时匹配扩展/标准标志 */
export function matchMessage(msg: MessageDef, frame: Pick<RawFrame, 'canId' | 'isExtended'>): boolean {
  return msg.canId === frame.canId && msg.isExtended === frame.isExtended;
}

function decodeOne(sig: SignalDef, data: Uint8Array, muxUnknown: boolean): DecodedSignal {
  const bitPositions = signalBitPositions(sig);
  const bitRanges = compactBitRanges(bitPositions);
  const raw = extractRaw(data, sig);
  // rawBits 按数值 MSB->LSB（与 2 进制书写一致），从已提取的 raw 生成
  const rawBits = raw.toString(2).padStart(sig.bitLength, '0');
  if (muxUnknown) {
    // 分支未知：不解释，仅保留 raw bits
    return {
      signalName: sig.name,
      byteOrder: sig.byteOrder,
      startBitDbc: sig.startBit,
      bitLength: sig.bitLength,
      bitPositions,
      bitRanges,
      raw: null,
      signedRaw: null,
      physical: null,
      factor: sig.factor,
      offset: sig.offset,
      unit: sig.unit,
      muxRole: sig.muxRole,
      enumValue: null,
      muxUnknown: true,
      rawBits
    };
  }
  const signedRaw = signExtend(raw, sig.bitLength, sig.sign);
  const physical = physicalValue(raw, sig);
  const enumValue = sig.enumMap[raw] ?? null;
  return {
    signalName: sig.name,
    byteOrder: sig.byteOrder,
    startBitDbc: sig.startBit,
    bitLength: sig.bitLength,
    bitPositions,
    bitRanges,
    raw,
    signedRaw,
    physical,
    factor: sig.factor,
    offset: sig.offset,
    unit: sig.unit,
    muxRole: sig.muxRole,
    enumValue,
    muxUnknown: false,
    rawBits
  };
}

export function decodeFrame(
  frame: RawFrame,
  dbc: import('./types.js').DbcVersion | null,
  message: MessageDef | null
): DecodedFrame {
  if (!dbc) return { frame, dbc, message: null, reason: 'no-effective-dbc', muxValue: null, signals: [] };
  if (!message) return { frame, dbc, message: null, reason: 'no-message-definition', muxValue: null, signals: [] };

  const data = hexToBytes(frame.dataHex);
  const signals = message.signals;
  const switchSig = signals.find((s) => s.muxRole === 'switch');

  let muxValue: number | null = null;
  if (switchSig) muxValue = extractRaw(data, switchSig);

  const out: DecodedSignal[] = [];
  for (const sig of signals) {
    const isUnknownBranch =
      typeof sig.muxRole === 'number' && muxValue !== null && sig.muxRole !== muxValue;
    out.push(decodeOne(sig, data, isUnknownBranch));
  }
  return { frame, dbc, message, reason: 'ok', muxValue, signals: out };
}
