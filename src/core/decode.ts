import { extractRaw, toSigned, signalBitPositions, dataBit } from './bits';
import type { MessageDef } from './dbc';

export interface DecodedSignal {
  name: string;
  raw: number | null;
  physical: number | null;
  enumLabel: string | null;
  unit?: string;
  bits: number[];
  bitRange: string;
  byteOrder: string;
  signed: boolean;
  factor: number;
  offset: number;
  kind: string;
  active: boolean;
  muxSwitchValue?: number;
}

export interface FrameDecode {
  messageName: string;
  sender: string;
  arbitrationId: number;
  isExtended: boolean;
  muxValue: number | null;
  muxBranchKnown: boolean;
  unknownMuxBits: number[];
  unknownMuxRawHex: string | null;
  signals: DecodedSignal[];
}

export function formatBitRange(bits: number[]): string {
  if (!bits.length) return '';
  const fmt = (b: number) => `B${Math.floor(b / 8)}.${b % 8}`;
  return `${fmt(bits[0])}→${fmt(bits[bits.length - 1])} (${bits.length}bit)`;
}

export function decodeMessage(data: Uint8Array, msg: MessageDef): FrameDecode {
  const muxor = msg.signals.find((s) => s.mux?.role === 'multiplexor');
  let muxValue: number | null = null;
  let muxBranchKnown = true;
  if (muxor) {
    muxValue = Number(extractRaw(data, muxor.startBit, muxor.length, muxor.byteOrder));
    muxBranchKnown = msg.signals.some(
      (s) => s.mux?.role === 'multiplexed' && s.mux.switchValue === muxValue
    );
  }

  const signals: DecodedSignal[] = msg.signals.map((sig) => {
    const bits = signalBitPositions(sig.startBit, sig.length, sig.byteOrder);
    let active = true;
    if (sig.mux?.role === 'multiplexed') active = sig.mux.switchValue === muxValue;
    let raw: number | null = null;
    let physical: number | null = null;
    let enumLabel: string | null = null;
    if (active) {
      let r = extractRaw(data, sig.startBit, sig.length, sig.byteOrder);
      if (sig.signed) r = toSigned(r, sig.length);
      raw = Number(r);
      physical = raw * sig.factor + sig.offset;
      enumLabel = sig.valueTable?.[raw] ?? null;
    }
    return {
      name: sig.name,
      raw,
      physical,
      enumLabel,
      unit: sig.unit,
      bits,
      bitRange: formatBitRange(bits),
      byteOrder: sig.byteOrder,
      signed: sig.signed,
      factor: sig.factor,
      offset: sig.offset,
      kind: sig.kind ?? 'normal',
      active,
      muxSwitchValue: sig.mux?.role === 'multiplexed' ? sig.mux.switchValue : undefined
    };
  });

  // Unknown mux branch: preserve the raw bits of the multiplexed payload region.
  let unknownMuxBits: number[] = [];
  let unknownMuxRawHex: string | null = null;
  if (muxor && !muxBranchKnown) {
    const set = new Set<number>();
    for (const s of msg.signals) {
      if (s.mux?.role !== 'multiplexed') continue;
      for (const b of signalBitPositions(s.startBit, s.length, s.byteOrder)) set.add(b);
    }
    unknownMuxBits = [...set].sort((a, b) => a - b);
    let v = 0n;
    for (const b of unknownMuxBits) v = (v << 1n) | BigInt(dataBit(data, b));
    unknownMuxRawHex = '0x' + v.toString(16);
  }

  return {
    messageName: msg.name,
    sender: msg.sender,
    arbitrationId: msg.arbitrationId,
    isExtended: msg.isExtended,
    muxValue,
    muxBranchKnown,
    unknownMuxBits,
    unknownMuxRawHex,
    signals
  };
}
