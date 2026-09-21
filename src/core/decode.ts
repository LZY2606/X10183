import type {
  DecodeResult,
  DecodedSignal,
  DbcLayout,
  FrameInput,
  MessageDef,
  SignalDef,
} from './types';
import { bitRanges, extractRaw, hexToBytes, rawBitsString, signalBitPositions, toSigned } from './bitfield';
import { crcEvidence } from './crc';

export function findMessage(
  layout: DbcLayout,
  arbitrationId: number,
  isExtended: boolean,
): MessageDef | null {
  return (
    layout.messages.find(
      (m) => m.arbitrationId === arbitrationId && m.isExtended === isExtended,
    ) ?? null
  );
}

function decodeSignal(
  sig: SignalDef,
  data: Uint8Array,
  active: boolean,
  keepRawOnly: boolean,
): DecodedSignal {
  const bits = signalBitPositions(sig.startBit, sig.length, sig.byteOrder);
  const ranges = bitRanges(bits);
  const rawBits = rawBitsString(data, sig.startBit, sig.length, sig.byteOrder);
  const base: DecodedSignal = {
    name: sig.name,
    role: sig.role ?? 'data',
    active,
    byteOrder: sig.byteOrder,
    signed: sig.signed,
    scale: sig.scale,
    offset: sig.offset,
    unit: sig.unit,
    rawValue: null,
    physicalValue: null,
    enumLabel: null,
    bits,
    ranges,
    rawBits: null,
    muxValues: sig.muxValues,
  };
  if (!active || keepRawOnly) {
    // Unknown / inactive mux branch: preserve raw bits, do not fabricate a value.
    return { ...base, rawBits };
  }
  const unsigned = extractRaw(data, sig.startBit, sig.length, sig.byteOrder);
  const raw = sig.signed ? toSigned(unsigned, sig.length) : unsigned;
  const physical = raw * sig.scale + sig.offset;
  const enumLabel = sig.valueTable ? sig.valueTable[unsigned] ?? null : null;
  return { ...base, rawValue: raw, physicalValue: physical, enumLabel };
}

export function decodeFrame(frame: FrameInput, layout: DbcLayout): DecodeResult {
  const data = hexToBytes(frame.data);
  const msg = findMessage(layout, frame.arbitrationId, frame.isExtended);
  if (!msg) {
    return {
      matched: false,
      reason: `当前 DBC 版本中没有匹配 ${frame.isExtended ? '扩展' : '标准'}帧 0x${frame.arbitrationId.toString(16)} 的消息定义`,
      arbitrationId: frame.arbitrationId,
      isExtended: frame.isExtended,
      muxValue: null,
      muxBranch: 'none',
      signals: [],
      crc: [],
    };
  }
  const muxor = msg.signals.find((s) => s.role === 'mux');
  let muxValue: number | null = null;
  let muxBranch: 'none' | 'known' | 'unknown' = 'none';
  const muxedSignals = msg.signals.filter((s) => s.muxValues && s.muxValues.length > 0);
  if (muxor) {
    muxValue = extractRaw(data, muxor.startBit, muxor.length, muxor.byteOrder);
    if (muxedSignals.length > 0) {
      muxBranch = muxedSignals.some((s) => s.muxValues!.includes(muxValue!))
        ? 'known'
        : 'unknown';
    }
  }

  const signals: DecodedSignal[] = msg.signals.map((sig) => {
    if (sig.role === 'mux') return decodeSignal(sig, data, true, false);
    if (sig.muxValues && sig.muxValues.length > 0) {
      if (muxBranch === 'unknown') return decodeSignal(sig, data, false, true);
      const active = muxValue != null && sig.muxValues.includes(muxValue);
      return decodeSignal(sig, data, active, false);
    }
    return decodeSignal(sig, data, true, false);
  });

  const crc = msg.signals
    .filter((s) => s.role === 'crc')
    .map((s) => {
      const raw = extractRaw(data, s.startBit, s.length, s.byteOrder);
      const value = s.signed ? toSigned(raw, s.length) : raw;
      return crcEvidence(s.name, s.crc, data, value);
    });

  return {
    matched: true,
    messageName: msg.name,
    sender: msg.sender,
    arbitrationId: frame.arbitrationId,
    isExtended: frame.isExtended,
    muxValue,
    muxBranch,
    signals,
    crc,
  };
}
