import type { MessageDef, SignalDef } from './dbc';

export interface BitSegment {
  byte: number;
  startBit: number;
  endBit: number;
}

export interface DecodedSignal {
  name: string;
  raw: number | null;
  value: number | null;
  unit: string;
  enumLabel: string | null;
  byteOrder: 'intel' | 'motorola';
  signed: boolean;
  scale: number;
  offset: number;
  startBit: number;
  length: number;
  bitPositions: number[];
  segments: BitSegment[];
  mux: 'none' | 'switch' | 'active' | 'inactive' | 'unknown-branch';
  rawBits: string | null;
}

export interface DecodedMessage {
  messageName: string;
  messageId: number;
  extended: boolean;
  transmitter: string;
  muxSwitchValue: number | null;
  muxBranchKnown: boolean;
  signals: DecodedSignal[];
}

export function signalBitPositions(
  sig: Pick<SignalDef, 'startBit' | 'length' | 'byteOrder'>,
): number[] {
  const positions: number[] = [];
  if (sig.byteOrder === 'intel') {
    for (let k = 0; k < sig.length; k++) positions.push(sig.startBit + k);
  } else {
    let p = sig.startBit;
    for (let k = 0; k < sig.length; k++) {
      positions.push(p);
      p = p % 8 === 0 ? p + 15 : p - 1;
    }
  }
  return positions;
}

export function segmentsFromPositions(positions: number[]): BitSegment[] {
  const segments: BitSegment[] = [];
  for (const pos of positions) {
    const byte = pos >> 3;
    const bit = pos & 7;
    const last = segments[segments.length - 1];
    if (last && last.byte === byte && bit === last.endBit + 1) {
      last.endBit = bit;
    } else if (last && last.byte === byte && bit === last.startBit - 1) {
      last.startBit = bit;
    } else {
      segments.push({ byte, startBit: bit, endBit: bit });
    }
  }
  return segments;
}

function getBit(data: Uint8Array, pos: number): number {
  const byte = pos >> 3;
  const bit = pos & 7;
  if (byte >= data.length) return 0;
  return (data[byte] >> bit) & 1;
}

export function extractRaw(data: Uint8Array, sig: Pick<SignalDef, 'startBit' | 'length' | 'byteOrder'>): number {
  const positions = signalBitPositions(sig);
  let raw = 0;
  if (sig.byteOrder === 'intel') {
    for (let k = 0; k < positions.length; k++) {
      raw += getBit(data, positions[k]) * 2 ** k;
    }
  } else {
    for (let k = 0; k < positions.length; k++) {
      raw += getBit(data, positions[k]) * 2 ** (positions.length - 1 - k);
    }
  }
  return raw;
}

export function rawBitsString(data: Uint8Array, positions: number[]): string {
  return positions.map((p) => String(getBit(data, p))).join('');
}

function toSigned(raw: number, length: number): number {
  if (length <= 0) return raw;
  const signBit = 2 ** (length - 1);
  if (raw >= signBit) return raw - 2 ** length;
  return raw;
}

export function decodeMessage(msg: MessageDef, data: Uint8Array): DecodedMessage {
  const switchSig = msg.signals.find((s) => s.mux.kind === 'switch') ?? null;
  let muxSwitchValue: number | null = null;
  if (switchSig) {
    muxSwitchValue = extractRaw(data, switchSig);
  }

  const knownBranches = new Set<number>();
  for (const sig of msg.signals) {
    if (sig.mux.kind === 'value') {
      for (const v of sig.mux.switchValues) knownBranches.add(v);
    }
  }
  const muxBranchKnown =
    switchSig === null || (muxSwitchValue !== null && knownBranches.has(muxSwitchValue));

  const signals: DecodedSignal[] = msg.signals.map((sig) => {
    const positions = signalBitPositions(sig);
    const segments = segmentsFromPositions(positions);
    const base = {
      name: sig.name,
      unit: sig.unit,
      byteOrder: sig.byteOrder,
      signed: sig.signed,
      scale: sig.scale,
      offset: sig.offset,
      startBit: sig.startBit,
      length: sig.length,
      bitPositions: positions,
      segments,
    };

    let muxState: DecodedSignal['mux'] = 'none';
    if (sig.mux.kind === 'switch') muxState = 'switch';
    else if (sig.mux.kind === 'value') {
      if (!muxBranchKnown) muxState = 'unknown-branch';
      else if (muxSwitchValue !== null && sig.mux.switchValues.includes(muxSwitchValue)) {
        muxState = 'active';
      } else {
        muxState = 'inactive';
      }
    }

    if (muxState === 'inactive') {
      return {
        ...base,
        raw: null,
        value: null,
        enumLabel: null,
        mux: muxState,
        rawBits: rawBitsString(data, positions),
      };
    }

    let raw = extractRaw(data, sig);
    if (sig.signed) raw = toSigned(raw, sig.length);
    const value = raw * sig.scale + sig.offset;
    const enumLabel = sig.enumValues[raw] ?? null;

    return {
      ...base,
      raw,
      value,
      enumLabel,
      mux: muxState,
      rawBits: muxState === 'unknown-branch' ? rawBitsString(data, positions) : null,
    };
  });

  return {
    messageName: msg.name,
    messageId: msg.id,
    extended: msg.extended,
    transmitter: msg.transmitter,
    muxSwitchValue,
    muxBranchKnown,
    signals,
  };
}
